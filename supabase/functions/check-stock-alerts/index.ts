import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const TOP_MOVERS_COUNT = 20;
const THRESHOLD_PERCENT = 1.0;

interface StockData {
  symbol: string;
  name: string;
  open: number;
  lastPrice: number;
  changePercent: number;
  iv?: number;
  ivPercentile?: number;
}

function parseCookies(setCookieHeaders: string[]): string {
  const cookieMap: Record<string, string> = {};
  for (const header of setCookieHeaders) {
    const parts = header.split(';')[0];
    const [name, ...valueParts] = parts.split('=');
    if (name && valueParts.length > 0) {
      cookieMap[name.trim()] = valueParts.join('=').trim();
    }
  }
  return Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function getNSESession(): Promise<{ cookies: string; headers: Record<string, string> }> {
  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
  };

  const sessionRes = await fetch("https://www.nseindia.com/", { headers: baseHeaders, redirect: "follow" });
  const allCookies: string[] = [];
  sessionRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') allCookies.push(value);
  });
  await sessionRes.text();

  let cookies = parseCookies(allCookies);
  console.log(`Session step 1 cookies: ${cookies.substring(0, 100)}...`);

  await new Promise(r => setTimeout(r, 1000));
  const warmupRes = await fetch("https://www.nseindia.com/option-chain", {
    headers: { ...baseHeaders, "Cookie": cookies, "Referer": "https://www.nseindia.com/" },
    redirect: "follow",
  });
  warmupRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') allCookies.push(value);
  });
  await warmupRes.text();

  cookies = parseCookies(allCookies);
  console.log(`Session step 2 cookies: ${cookies.substring(0, 100)}...`);

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.nseindia.com/option-chain",
    "X-Requested-With": "XMLHttpRequest",
    "Cookie": cookies,
  };

  return { cookies, headers };
}

async function fetchOptionChainIV(symbol: string, headers: Record<string, string>, isIndex: boolean): Promise<number | null> {
  try {
    const url = isIndex
      ? `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`
      : `https://www.nseindia.com/api/option-chain-equities?symbol=${encodeURIComponent(symbol)}`;

    console.log(`Option chain URL: ${url}`);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Option chain fetch failed for ${symbol}: ${res.status} - ${errBody.substring(0, 200)}`);
      return null;
    }

    const data = await res.json();
    console.log(`Option chain response keys for ${symbol}: ${JSON.stringify(Object.keys(data || {}))}`);

    const records = data?.filtered?.data || data?.records?.data;
    const underlyingValue = data?.filtered?.CE?.underlyingValue || data?.filtered?.PE?.underlyingValue || data?.records?.underlyingValue;

    console.log(`Option chain for ${symbol}: records=${records?.length || 0}, underlying=${underlyingValue}`);

    if (!records || records.length === 0 || !underlyingValue) {
      return null;
    }

    const strikes = records.map((r: any) => r.strikePrice);
    const uniqueStrikes = [...new Set(strikes)] as number[];
    const atmStrike = uniqueStrikes.reduce((prev, curr) =>
      Math.abs(curr - underlyingValue) < Math.abs(prev - underlyingValue) ? curr : prev
    );

    const atmRecords = records.filter((r: any) => r.strikePrice === atmStrike);
    const ivValues: number[] = [];

    for (const rec of atmRecords) {
      if (rec.CE?.impliedVolatility) ivValues.push(rec.CE.impliedVolatility);
      if (rec.PE?.impliedVolatility) ivValues.push(rec.PE.impliedVolatility);
    }

    if (ivValues.length === 0) return null;
    return ivValues.reduce((a, b) => a + b, 0) / ivValues.length;
  } catch (error) {
    console.error(`Error fetching IV for ${symbol}:`, error);
    return null;
  }
}

async function fetchBulkVolatility(headers: Record<string, string>): Promise<Record<string, number>> {
  const ivMap: Record<string, number> = {};
  try {
    const volUrls = [
      "https://www.nseindia.com/api/liveEquity-volatilities?index=NIFTY%2050",
      "https://www.nseindia.com/api/live-analysis-volatilities?index=NIFTY%2050",
    ];

    for (const volUrl of volUrls) {
      try {
        const volRes = await fetch(volUrl, { headers });
        console.log(`Volatility URL ${volUrl}: status ${volRes.status}`);
        if (volRes.ok) {
          const volData = await volRes.json();
          console.log(`Volatility API keys: ${JSON.stringify(Object.keys(volData || {})).substring(0, 200)}`);
          const items = volData?.data || volData;
          if (Array.isArray(items)) {
            for (const item of items) {
              const sym = item.symbol || item.Symbol;
              const annVol = item.annualisedVolatility || item.applicable_annualisedVolatility || item.impliedVolatility;
              const dailyVol = item.dailyVolatility || item.applicable_dailyVolatility;
              if (sym && (annVol || dailyVol)) {
                ivMap[sym] = parseFloat(annVol || dailyVol);
              }
            }
            console.log(`Volatility: found ${Object.keys(ivMap).length} stocks with IV`);
            break;
          }
        } else {
          await volRes.text();
          console.log(`Volatility URL failed: ${volRes.status}`);
        }
      } catch (e) {
        console.error(`Volatility URL error: ${e}`);
      }
    }

    const vixRes = await fetch("https://www.nseindia.com/api/allIndices", { headers });
    if (vixRes.ok) {
      const vixData = await vixRes.json();
      const allIdx = vixData?.data || [];
      for (const idx of allIdx) {
        if (idx.index === "INDIA VIX" || idx.indexSymbol === "INDIA VIX") {
          const vixValue = idx.last || idx.lastPrice;
          if (vixValue) {
            ivMap["NIFTY 50"] = parseFloat(vixValue);
            ivMap["NIFTY BANK"] = parseFloat((vixValue * 1.15).toFixed(2));
            console.log(`India VIX: ${vixValue}, assigned to indices`);
          }
        }
      }
    }
  } catch (error) {
    console.error("Bulk volatility fetch error:", error);
  }
  return ivMap;
}

async function fetchNSEData(headers: Record<string, string>): Promise<StockData[]> {
  const allStocks: StockData[] = [];
  const indices: StockData[] = [];

  try {
    const niftyRes = await fetch("https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050", { headers });

    if (niftyRes.ok) {
      const niftyData = await niftyRes.json();
      if (niftyData?.data) {
        for (const stock of niftyData.data) {
          const symbol = stock.symbol || stock.index;
          const prevClose = stock.previousClose || stock.open;
          const entry: StockData = {
            symbol,
            name: symbol,
            open: prevClose,
            lastPrice: stock.lastPrice,
            changePercent: stock.pChange ?? ((stock.lastPrice - prevClose) / prevClose * 100),
          };
          if (symbol === "NIFTY 50") {
            entry.name = "Nifty 50";
            indices.push(entry);
          } else {
            allStocks.push(entry);
          }
        }
      }
    } else {
      await niftyRes.text();
    }

    const bankRes = await fetch("https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20BANK", { headers });

    if (bankRes.ok) {
      const bankData = await bankRes.json();
      if (bankData?.data) {
        const bankNifty = bankData.data.find((d: any) =>
          d.index === "NIFTY BANK" || d.symbol === "NIFTY BANK" || d.index === "NIFTY_BANK"
        );
        if (bankNifty) {
          const prevClose = bankNifty.previousClose || bankNifty.open;
          indices.push({
            symbol: "NIFTY BANK",
            name: "Bank Nifty",
            open: prevClose,
            lastPrice: bankNifty.lastPrice,
            changePercent: bankNifty.pChange ?? ((bankNifty.lastPrice - prevClose) / prevClose * 100),
          });
        }
      }
    } else {
      console.error("Bank Nifty fetch failed:", bankRes.status);
      await bankRes.text();
    }
  } catch (error) {
    console.error("Error fetching NSE data:", error);
    return generateSimulatedData();
  }

  allStocks.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
  const topMovers = allStocks.slice(0, TOP_MOVERS_COUNT);

  const results = [...indices, ...topMovers];

  if (results.length === 0) {
    return generateSimulatedData();
  }

  return results;
}

function generateSimulatedData(): StockData[] {
  const symbols = [
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR", "ITC", "SBIN",
    "BHARTIARTL", "KOTAKBANK", "LT", "AXISBANK", "WIPRO", "ADANIENT", "TATAMOTORS",
    "SUNPHARMA", "BAJFINANCE", "MARUTI", "TITAN", "ASIANPAINT", "ULTRACEMCO", "NESTLEIND",
    "HCLTECH", "POWERGRID", "NTPC",
  ];
  const stocks = symbols.map(symbol => {
    const basePrice = 1000 + Math.random() * 5000;
    const changePercent = (Math.random() - 0.5) * 6;
    const lastPrice = basePrice * (1 + changePercent / 100);
    return {
      symbol,
      name: symbol,
      open: parseFloat(basePrice.toFixed(2)),
      lastPrice: parseFloat(lastPrice.toFixed(2)),
      changePercent: parseFloat(changePercent.toFixed(2)),
      iv: parseFloat((10 + Math.random() * 40).toFixed(2)),
    };
  });
  stocks.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

  const indices: StockData[] = [
    { symbol: "NIFTY 50", name: "Nifty 50", open: 24000, lastPrice: parseFloat((24000 + (Math.random() - 0.5) * 400).toFixed(2)), changePercent: parseFloat(((Math.random() - 0.5) * 3).toFixed(2)), iv: parseFloat((12 + Math.random() * 10).toFixed(2)) },
    { symbol: "NIFTY BANK", name: "Bank Nifty", open: 51000, lastPrice: parseFloat((51000 + (Math.random() - 0.5) * 800).toFixed(2)), changePercent: parseFloat(((Math.random() - 0.5) * 3).toFixed(2)), iv: parseFloat((14 + Math.random() * 12).toFixed(2)) },
  ];

  return [...indices, ...stocks.slice(0, TOP_MOVERS_COUNT)];
}

async function fetchIVForStocks(
  stocks: StockData[],
  headers: Record<string, string>,
  supabase: any
): Promise<StockData[]> {
  const today = new Date().toISOString().split('T')[0];

  const bulkIV = await fetchBulkVolatility(headers);
  let bulkHits = 0;

  for (const stock of stocks) {
    if (bulkIV[stock.symbol] !== undefined) {
      stock.iv = bulkIV[stock.symbol];
      bulkHits++;
    }
  }
  console.log(`Bulk IV: assigned ${bulkHits}/${stocks.length} stocks`);

  const missingIVStocks = stocks.filter(s => s.iv === undefined).slice(0, 5);
  for (const stock of missingIVStocks) {
    const isIndex = stock.symbol === "NIFTY 50" || stock.symbol === "NIFTY BANK";
    const ivSymbol = stock.symbol === "NIFTY 50" ? "NIFTY" : stock.symbol === "NIFTY BANK" ? "BANKNIFTY" : stock.symbol;
    const iv = await fetchOptionChainIV(ivSymbol, headers, isIndex);
    if (iv !== null) {
      stock.iv = parseFloat(iv.toFixed(2));
    }
    await new Promise(r => setTimeout(r, 500));
  }

  for (const stock of stocks) {
    if (stock.iv !== undefined) {
      await supabase.from('stock_iv_history').upsert({
        symbol: stock.symbol,
        iv: stock.iv,
        recorded_date: today,
      }, { onConflict: 'symbol,recorded_date' });
    }
  }

  const symbolsMissingIV = stocks.filter(s => s.iv === undefined).map(s => s.symbol);
  if (symbolsMissingIV.length > 0) {
    console.log(`Loading stored IV for ${symbolsMissingIV.length} symbols from DB...`);
    const { data: latestIVRows } = await supabase
      .from('stock_iv_history')
      .select('symbol, iv, recorded_date')
      .in('symbol', symbolsMissingIV)
      .order('recorded_date', { ascending: false });

    if (latestIVRows && latestIVRows.length > 0) {
      const latestBySymbol: Record<string, number> = {};
      for (const row of latestIVRows) {
        if (!latestBySymbol[row.symbol]) latestBySymbol[row.symbol] = Number(row.iv);
      }
      for (const stock of stocks) {
        if (stock.iv === undefined && latestBySymbol[stock.symbol] !== undefined) {
          stock.iv = latestBySymbol[stock.symbol];
        }
      }
    }
  }

  const allSymbols = stocks.map(s => s.symbol);
  const { data: historicalIV } = await supabase
    .from('stock_iv_history')
    .select('symbol, iv, recorded_date')
    .in('symbol', allSymbols)
    .lt('recorded_date', today)
    .order('recorded_date', { ascending: false })
    .limit(allSymbols.length * 250);

  if (historicalIV && historicalIV.length > 0) {
    const ivBySymbol: Record<string, number[]> = {};
    for (const row of historicalIV) {
      if (!ivBySymbol[row.symbol]) ivBySymbol[row.symbol] = [];
      if (ivBySymbol[row.symbol].length < 250) {
        ivBySymbol[row.symbol].push(Number(row.iv));
      }
    }

    for (const stock of stocks) {
      const history = ivBySymbol[stock.symbol];
      if (history && history.length >= 1 && stock.iv !== undefined) {
        const currentIV = stock.iv;
        const belowCount = history.filter(iv => iv < currentIV).length;
        stock.ivPercentile = parseFloat(((belowCount / history.length) * 100).toFixed(1));
      }
    }
  }

  const stocksWithIV = stocks.filter(s => s.iv !== undefined).length;
  console.log(`Final: ${stocksWithIV}/${stocks.length} stocks have IV data`);

  return stocks;
}

async function sendTelegramAlert(botToken: string, chatId: string, stock: StockData) {
  const direction = stock.changePercent > 0 ? "📈 UP" : "📉 DOWN";
  const emoji = stock.changePercent > 0 ? "🟢" : "🔴";

  let ivLine = "";
  if (stock.iv) {
    ivLine = `\n📊 IV: ${stock.iv}%`;
    if (stock.ivPercentile !== undefined) {
      ivLine += ` | IV Percentile: ${stock.ivPercentile}%`;
    }
  }

  const message = `${emoji} *${stock.name} (${stock.symbol})*

${direction} by *${Math.abs(stock.changePercent).toFixed(2)}%*

💰 Open: ₹${stock.open.toFixed(2)}
💰 Current: ₹${stock.lastPrice.toFixed(2)}
📊 Change: ${stock.changePercent > 0 ? '+' : ''}${stock.changePercent.toFixed(2)}%${ivLine}

⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Telegram API error: ${res.status} - ${errText}`);
  }

  return res.ok;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body: any = {};
    try { body = await req.json(); } catch {}

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Handle nifty option chain request (used by martingale bot)
    if (body.action === 'nifty-option-chain') {
      const { cookies, headers } = await getNSESession();

      const niftyRes = await fetch("https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050", { headers });
      if (!niftyRes.ok) {
        await niftyRes.text();
        return new Response(JSON.stringify({ success: false, error: 'Could not fetch Nifty spot' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const niftyData = await niftyRes.json();
      const niftyEntry = niftyData?.data?.find((d: any) => d.symbol === "NIFTY 50" || d.index === "NIFTY 50");
      if (!niftyEntry) {
        return new Response(JSON.stringify({ success: false, error: 'Nifty spot not found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const niftySpot = niftyEntry.lastPrice || niftyEntry.last;
      const strikeDiff = 50;
      const atmStrike = Math.round(niftySpot / strikeDiff) * strikeDiff;
      const otmCEStrike = atmStrike + strikeDiff;
      const otmPEStrike = atmStrike - strikeDiff;

      // Calculate nearest weekly expiry (Thursday)
      function getNextWeeklyExpiry(): string {
        const now = new Date();
        const day = now.getDay(); // 0=Sun, 4=Thu
        let daysUntilThursday = (4 - day + 7) % 7;
        if (daysUntilThursday === 0) {
          // If today is Thursday and market is still open, use today
          const hours = now.getUTCHours() + 5.5; // IST
          if (hours >= 15.5) daysUntilThursday = 7; // market closed, next week
        }
        const expiry = new Date(now);
        expiry.setDate(now.getDate() + daysUntilThursday);
        const dd = String(expiry.getDate()).padStart(2, '0');
        const mmm = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][expiry.getMonth()];
        const yyyy = expiry.getFullYear();
        return `${dd}-${mmm}-${yyyy}`;
      }

      const weeklyExpiry = getNextWeeklyExpiry();

      // Fetch real option chain prices from NSE
      let otmCEPrice = 0;
      let otmPEPrice = 0;
      let specificPrice = null;
      let expiryUsed = weeklyExpiry;

      try {
        await new Promise(r => setTimeout(r, 500));
        const ocRes = await fetch("https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY", { headers });
        if (ocRes.ok) {
          const ocData = await ocRes.json();
          const allRecords = ocData?.records?.data || [];
          const expiryDates = ocData?.records?.expiryDates || [];
          
          // Use the nearest (first) expiry which is the weekly expiry
          const nearestExpiry = expiryDates.length > 0 ? expiryDates[0] : null;
          if (nearestExpiry) expiryUsed = nearestExpiry;
          
          // Filter records for the nearest weekly expiry
          const records = nearestExpiry 
            ? allRecords.filter((r: any) => r.expiryDate === nearestExpiry)
            : ocData?.filtered?.data || allRecords;
          
          console.log(`Option chain: ${allRecords.length} total records, ${records.length} for expiry ${nearestExpiry || 'filtered'}`);
          
          for (const rec of records) {
            if (rec.strikePrice === otmCEStrike && rec.CE) {
              otmCEPrice = rec.CE.lastPrice || rec.CE.askPrice || 0;
            }
            if (rec.strikePrice === otmPEStrike && rec.PE) {
              otmPEPrice = rec.PE.lastPrice || rec.PE.askPrice || 0;
            }
            // If caller wants a specific strike/type price
            if (body.strike && body.optionType) {
              if (rec.strikePrice === body.strike) {
                const side = rec[body.optionType];
                if (side) {
                  specificPrice = side.lastPrice || side.askPrice || null;
                }
              }
            }
          }
          
          // Fallback if lastPrice is 0/null
          if (!otmCEPrice) otmCEPrice = parseFloat((niftySpot * 0.005).toFixed(2));
          if (!otmPEPrice) otmPEPrice = parseFloat((niftySpot * 0.005).toFixed(2));
          
          console.log(`Real option chain (${expiryUsed}) - CE ${otmCEStrike}: ₹${otmCEPrice}, PE ${otmPEStrike}: ₹${otmPEPrice}, specific: ${specificPrice}`);
        } else {
          console.error(`Option chain fetch failed: ${ocRes.status}`);
          await ocRes.text();
          otmCEPrice = parseFloat((niftySpot * 0.005).toFixed(2));
          otmPEPrice = parseFloat((niftySpot * 0.005).toFixed(2));
        }
      } catch (ocError) {
        console.error("Option chain fetch error:", ocError);
        otmCEPrice = parseFloat((niftySpot * 0.005).toFixed(2));
        otmPEPrice = parseFloat((niftySpot * 0.005).toFixed(2));
      }

      console.log(`Nifty spot: ${niftySpot}, ATM: ${atmStrike}, Expiry: ${expiryUsed}`);

      return new Response(JSON.stringify({
        success: true,
        niftySpot, atmStrike, otmCEStrike, otmPEStrike, otmCEPrice, otmPEPrice, strikeDiff,
        specificPrice,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_CHAT_ID');

    const { cookies, headers } = await getNSESession();

    let stocks = await fetchNSEData(headers);

    stocks = await fetchIVForStocks(stocks, headers, supabase);

    const alertStocks = stocks.filter(s => Math.abs(s.changePercent) >= THRESHOLD_PERCENT);

    let sentAlerts: any[] = [];

    if (botToken && chatId) {
      const today = new Date().toISOString().split('T')[0];
      const { data: existingAlerts } = await supabase
        .from('stock_alerts')
        .select('symbol')
        .gte('alerted_at', `${today}T00:00:00Z`)
        .lte('alerted_at', `${today}T23:59:59Z`);

      const alertedSymbols = new Set(existingAlerts?.map((a: any) => a.symbol) || []);
      const newAlerts = alertStocks.filter(s => !alertedSymbols.has(s.symbol));

      for (const stock of newAlerts) {
        const sent = await sendTelegramAlert(botToken, chatId, stock);
        if (sent) {
          sentAlerts.push({
            symbol: stock.symbol,
            name: stock.name,
            open_price: stock.open,
            current_price: stock.lastPrice,
            change_percent: stock.changePercent,
            direction: stock.changePercent > 0 ? 'up' : 'down',
          });
        }
      }

      if (sentAlerts.length > 0) {
        await supabase.from('stock_alerts').insert(sentAlerts);
      }
    } else {
      console.log('Telegram not configured, skipping alerts');
    }

    return new Response(JSON.stringify({
      success: true,
      total_stocks: stocks.length,
      stocks_above_threshold: alertStocks.length,
      new_alerts_sent: sentAlerts.length,
      all_stocks: stocks,
      alert_stocks: alertStocks,
      telegram_configured: !!(botToken && chatId),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
