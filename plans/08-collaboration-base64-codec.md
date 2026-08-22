# 08 — Collaboration Base64 codec 與 snapshot 效能門檻

## 目標

把 collaboration 的 binary/Base64 轉換集中到共用、可測試的 codec，讓大型 durable
snapshot 在支援現代 TypedArray Base64 API 的瀏覽器走原生路徑，同時保留明確且有測試的
相容 fallback。以固定 4 MiB fixture 建立 correctness、延遲與記憶體證據，避免每 30 秒的
snapshot cadence 在主執行緒形成 long task。

目前 `snapshot-store.ts` 的 8 KiB chunk 已消除逐 byte 字串串接，但仍必須建立完整 binary
string 再交給 `btoa()`；decode 也仍由 `atob()` 產生 binary string 後逐 byte 複製。現代
`Uint8Array.prototype.toBase64()`／`Uint8Array.fromBase64()` 已進入 ECMAScript，且 2025 年
起在最新主流瀏覽器可用，但舊裝置與 webview 仍需 fallback：

- [TC39 TypedArray Base64 specification](https://tc39.es/proposal-arraybuffer-base64/spec/)
- [MDN `Uint8Array.prototype.toBase64()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array/toBase64)
- [MDN `Uint8Array.fromBase64()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array/fromBase64)

## 範圍邊界

- 不再以檔案行數為理由拆分 `collaboration-session.ts`。目前 session 子系統已有明確 module
  ownership；top-level factory 擁有 shared runtime state、跨元件 transition ordering 與 public
  facade，是合理的 composition root。只有出現新的獨立責任或可驗證的變更熱點時才再抽取。
- 不改 snapshot wire/storage schema、crypto version、AAD、revision、checksum、4 MiB plaintext
  上限或 tRPC API。
- 不引入 Base64 polyfill 或 runtime dependency，不提高整個 repo 的 TypeScript `lib` target，
  不使用 `any`。
- 只收斂 collaboration 的密碼學／snapshot call sites；`apps/web/src/lib/encode.ts` 與 personal
  library 的既有格式不在本次範圍。
- 不預先導入 Web Worker 或改成 binary HTTP endpoint。若原生快路徑仍無法通過本文效能門檻，
  先以量測結果另開 plan，不在本次順手擴張架構。

## P1 — 共用 codec 與能力偵測

新增 `packages/collaboration/src/base64.ts` 與 `./base64` package export，提供：

- `encodeBase64(bytes)`／`decodeBase64(value, { maxBytes })`；
- `encodeBase64Url(bytes, { omitPadding: true })`／`decodeBase64Url(value, { maxBytes })`；
- feature-detected native path：`Uint8Array#toBase64`、`Uint8Array.fromBase64`；
- 現行 chunked `btoa`／`atob` fallback。

實作要求：

1. capability detection 只用窄的 structural type，不調高 `ES2022` lib、不改 global declaration；
2. native 與 fallback 必須有相同輸出、padding、base64url alphabet 與錯誤語意；
3. fallback 的 chunk size 固定且有理由，不能退回 per-byte string concatenation；
4. decode 先以 encoded length 拒絕不可能落在 `maxBytes` 內的輸入，完成後再檢查實際
   byte length；不能先配置無界 binary string／typed array 才套上限；
5. codec 不讀 room、key 或 scene state，維持 pure binary boundary。

## P2 — 收斂 collaboration call sites

改用共用 codec，並移除被取代的 private helpers：

- `packages/collaboration/src/keycheck.ts` 的標準 Base64；
- `packages/collaboration/src/realtime-crypto.ts` 的 unpadded Base64URL room key；
- `apps/web/src/lib/collab/snapshot-store.ts` 的大型 ciphertext Base64。

遷移不得改變既有 schema、stored value 或 share link。固定 room-key、key-check 與 snapshot
vectors 必須逐 byte／逐字元相同，既有資料不需要 migration 或 compatibility reader。

## P3 — Correctness 與 host coverage

新增 `packages/collaboration/tests/base64.test.ts`，並納入既有 Node、Chromium、WebKit test
projects。至少覆蓋：

- empty、1/2/3-byte padding、0–255 全 byte range；
- 8,191／8,192／8,193 byte chunk boundaries；
- 標準 Base64 與 unpadded Base64URL fixed vectors；
- malformed alphabet、padding 與 truncated input；
- 4 MiB deterministic payload round-trip；
- native 與 fallback 強制路徑輸出一致；
- native API 不存在時確實走 fallback，而不是 import-time failure。

既有 `keycheck`、`realtime-crypto`、`snapshot` suites 必須原樣通過，作為跨 room、generation、
crypto version 與 stored-format regression coverage。

## P4 — 4 MiB 效能證據與決策門檻

實作前先在同一台機器記錄目前 chunked snapshot helper 的 baseline；實作後以同一 fixture、
runtime、warmup 與 iteration 數量重跑。量測工具必須呼叫 production codec，而不是複製一份
benchmark-only implementation。

固定輸出：

- runtime／browser version、OS、CPU architecture；
- 4 MiB input 與 Base64 output bytes；
- encode/decode p50、p95、max；
- native capability 是否存在、實際選到 native 或 fallback；
- working 與 retained heap delta（可用的 host 才量，並標示方法）；
- warmup、iterations 與 fixture seed。

至少在 Node、Chromium desktop、WebKit desktop 執行；browser measurement 不得為了方便而啟動
整個 Drawstuff app，應使用 package-level browser test/benchmark harness。

接受條件：

1. current Chromium 與 WebKit 的 production-selected encode、decode 各自 p95 不超過 50 ms，
   避免單一 Base64 階段本身成為 long task；
2. native path 在相同 host/fixture 必須快於 fallback，否則不保留無效分支；
3. fallback 的 p95 不得比實作前同機 baseline 退步超過 10%；
4. retained heap 不得隨 iteration 成長；
5. 若 current supported browser 缺少 native API 且 fallback 超過 50 ms，停止結案並根據證據另提
   Web Worker 或 binary transport plan，不調寬 budget 掩蓋結果。

結果與 budget 更新到 `docs/performance/collaboration-slo-capacity.md`；只保存可重跑方法、環境、
數值與 rollback implication，不把一次性的 console output 當文件。

## 驗證與完成條件

依序執行：

1. `pnpm --filter @drawstuff/collaboration test`
2. 新增的 4 MiB Node／Chromium／WebKit benchmark command
3. `pnpm lint`
4. `pnpm typecheck`
5. `pnpm test`
6. `pnpm knip`

完成後同步更新 collaboration architecture/performance 文件，修正所有 inbound references，並
依 `plans/README.md` 的規則移除本 plan。
