-- Data migration: corrige o quoteAmount (SOL) de trades Solana cujos PROVENTOS foram
-- pagos em SOL NATIVO (pump.fun/bonding curve). Bug: a reconstrução somava apenas os
-- `nativeTransfers` (que nessas txs só contêm as SAÍDAS de taxa), zerando a venda =
-- prejuízo fantasma. A fonte correta é `accountData.nativeBalanceChange` (mudança
-- LÍQUIDA de saldo). Este SQL espelha 1:1 a lógica de HeliusSolanaProvider.reconstruct
-- (validada: mesmos valores do recompute em TS) e reescala usdValue/priceUsd para
-- preservar o preço do SOL implícito. Idempotente por natureza (só toca linhas onde o
-- valor muda). Só afeta a perna SOL (quoteMint = WSOL).

WITH recomputed AS (
  SELECT
    t.id,
    t."quoteAmount"::numeric AS old_q,
    t."usdValue"::numeric    AS old_usd,
    t."priceUsd"::numeric    AS old_price,
    -- Perna WSOL (bruta): soma assinada dos tokenTransfers de WSOL do endereço.
    COALESCE((
      SELECT abs(sum(
        (CASE WHEN tt->>'toUserAccount'   = w.address THEN (tt->>'tokenAmount')::numeric ELSE 0 END)
      - (CASE WHEN tt->>'fromUserAccount' = w.address THEN (tt->>'tokenAmount')::numeric ELSE 0 END)))
      FROM jsonb_array_elements(t.raw->'tokenTransfers') tt
      WHERE tt->>'mint' = 'So11111111111111111111111111111111111111112'
    ), 0) AS wsol_leg,
    -- Δnative REAL: accountData.nativeBalanceChange do endereço; fallback = soma dos
    -- nativeTransfers (comportamento antigo, quando não há accountData).
    COALESCE(
      (SELECT (ad->>'nativeBalanceChange')::numeric / 1e9
       FROM jsonb_array_elements(t.raw->'accountData') ad
       WHERE ad->>'account' = w.address
       LIMIT 1),
      COALESCE((
        SELECT sum(
          (CASE WHEN nt->>'toUserAccount'   = w.address THEN (nt->>'amount')::numeric ELSE 0 END)
        - (CASE WHEN nt->>'fromUserAccount' = w.address THEN (nt->>'amount')::numeric ELSE 0 END)) / 1e9
        FROM jsonb_array_elements(t.raw->'nativeTransfers') nt
      ), 0)
    ) AS sol_native
  FROM "Trade" t
  JOIN "Wallet" w ON w.id = t."walletId"
  WHERE t."quoteMint" = 'So11111111111111111111111111111111111111112'
    AND t.raw IS NOT NULL
),
final AS (
  SELECT
    id, old_q, old_usd, old_price,
    -- Mesmo branch do provider: nativo incidental → perna WSOL; senão o Δnative real.
    CASE
      WHEN wsol_leg >= 1e-12 AND abs(sol_native) < 0.5 * wsol_leg THEN wsol_leg
      WHEN abs(sol_native) > 1e-9 THEN abs(sol_native)
      ELSE wsol_leg
    END AS new_q
  FROM recomputed
)
UPDATE "Trade" t SET
  "quoteAmount" = f.new_q,
  "usdValue"    = f.old_usd   * (f.new_q / f.old_q),
  "priceUsd"    = f.old_price * (f.new_q / f.old_q),
  "createdAt"   = now()  -- muda o tradesHash → invalida o snapshot de métricas
FROM final f
WHERE t.id = f.id
  AND f.old_q > 0
  AND abs(f.new_q - f.old_q) > 1e-9;

-- Invalida TODO o cache de métricas (recomputa sozinho com os trades corrigidos).
DELETE FROM "MetricSnapshot";
