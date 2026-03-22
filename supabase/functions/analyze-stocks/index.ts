import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { stocks } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    if (!stocks || !Array.isArray(stocks) || stocks.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "No stock data provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const stockSummary = stocks
      .filter((s: any) => s.symbol !== "NIFTY 50" && s.symbol !== "NIFTY BANK")
      .map((s: any) => {
        const parts = [
          `${s.symbol} (${s.name}): ${s.changePercent >= 0 ? "+" : ""}${s.changePercent.toFixed(2)}%, Price: ₹${s.lastPrice}`,
        ];
        if (s.iv !== undefined) parts.push(`IV: ${s.iv.toFixed(1)}%`);
        if (s.ivPercentile !== undefined) parts.push(`IV Percentile: ${s.ivPercentile.toFixed(0)}`);
        return parts.join(", ");
      })
      .join("\n");

    const niftyData = stocks.find((s: any) => s.symbol === "NIFTY 50");
    const bankNiftyData = stocks.find((s: any) => s.symbol === "NIFTY BANK");
    const marketContext = [
      niftyData ? `NIFTY 50: ₹${niftyData.lastPrice} (${niftyData.changePercent >= 0 ? "+" : ""}${niftyData.changePercent.toFixed(2)}%)` : "",
      bankNiftyData ? `NIFTY BANK: ₹${bankNiftyData.lastPrice} (${bankNiftyData.changePercent >= 0 ? "+" : ""}${bankNiftyData.changePercent.toFixed(2)}%)` : "",
    ].filter(Boolean).join("\n");

    const systemPrompt = `You are an expert Indian stock market analyst specializing in NSE stocks. 
You analyze daily stock movements, implied volatility data, and market conditions to identify stocks with potential for 3-5% upside in the next 1 month.

Your analysis should consider:
1. Momentum - stocks showing consistent positive movement
2. IV Percentile - low IV percentile (<30) suggests options are cheap and potential for big moves
3. Sector strength - if multiple stocks from same sector are moving up
4. Market context - overall NIFTY/BANKNIFTY direction
5. Risk factors - what could go wrong

Be practical and conservative. Only recommend stocks where you see genuine potential.
Always include a confidence level (High/Medium/Low) and a brief rationale.

IMPORTANT: Return your analysis as a valid JSON object with this exact structure:
{
  "market_outlook": "brief 1-2 sentence market view",
  "recommendations": [
    {
      "symbol": "STOCK_SYMBOL",
      "name": "Stock Name", 
      "current_price": 1234.56,
      "target_percent": "3-5%",
      "confidence": "High|Medium|Low",
      "rationale": "Why this stock could move up",
      "risk": "Key risk to watch",
      "timeframe": "2-4 weeks"
    }
  ],
  "avoid": ["SYMBOL1 - reason", "SYMBOL2 - reason"],
  "sector_insights": "brief sector-level observation"
}

Return 3-6 recommendations maximum. Only include stocks from the provided data.`;

    const userPrompt = `Here is today's market data for NSE stocks:

Market Overview:
${marketContext}

Stock Movements (sorted by change %):
${stockSummary}

Based on this data, identify stocks that have potential to give 3-5% returns in the next month. Analyze the momentum, IV data, and market context to make your recommendations.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ success: false, error: "Rate limit exceeded, please try again later." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ success: false, error: "AI credits exhausted. Please add funds." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errText = await response.text();
      console.error("AI gateway error:", response.status, errText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const aiData = await response.json();
    const content = aiData.choices?.[0]?.message?.content || "";

    // Parse the JSON from AI response
    let analysis;
    try {
      // Try to extract JSON from the response (it might be wrapped in markdown code blocks)
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      analysis = JSON.parse(jsonMatch[1].trim());
    } catch {
      // If JSON parsing fails, return raw content
      analysis = {
        market_outlook: "Analysis available in text format",
        raw_analysis: content,
        recommendations: [],
        avoid: [],
        sector_insights: "",
      };
    }

    return new Response(
      JSON.stringify({ success: true, analysis, generated_at: new Date().toISOString() }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("analyze-stocks error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
