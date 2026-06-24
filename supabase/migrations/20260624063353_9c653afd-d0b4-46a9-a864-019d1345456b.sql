REVOKE ALL ON FUNCTION public.invoke_martingale_sniper_cron_tick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_martingale_general_cron_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_martingale_sniper_cron_tick() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.invoke_martingale_general_cron_tick() TO postgres, service_role;