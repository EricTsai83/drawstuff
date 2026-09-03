# Docs 閱讀指南

這個目錄有兩種性質不同的文件，讀之前先分清楚：

| 目錄 | 性質 | 讀者 | 語言風格 |
| --- | --- | --- | --- |
| `system-design/` | **可轉移的 System Design pattern**：從本專案萃取、以通用語言撰寫，目標是能套用到其他專案 | 任何工程師（不需要熟悉本 codebase） | 通用術語為主，只在文末連回本專案實例 |
| `adr/`、`architecture/`、`observability/`、`operations/`、`performance/` | **本專案的現況契約**：具體到檔名、常數與門檻數字，是實作與 review 的依據 | 本專案的開發者 | 專案術語 |

另外，repo 根目錄的 `plans/` 只放**未完成**的範圍化工作；計畫完成後會回寫到
`docs/` 的現況文件並刪除計畫檔（規則見
[engineering conventions](./operations/engineering-conventions.md)）。
所以：`docs/` 永遠描述現在的系統，歷史在 git history 與 ADR 裡。

## 如何讀 `system-design/`

**從 [系統總覽](./system-design/system-overview.md) 開始**：它有整體 System
Architecture 圖與端到端 data flow（前端 ↔ 後端 ↔ realtime worker 的完整時序），
以及「元件 × pattern」對照表，讀完就知道每篇 pattern 落在系統的哪個位置。

圖示慣例：所有架構圖與流程圖用 Mermaid 撰寫（GitHub 直接渲染）。
`flowchart` 畫拓撲與決策流、`sequenceDiagram` 畫跨元件的溝通時序、
`stateDiagram` 畫狀態機；flowchart 中的 `x--x` 連線表示**被禁止的依賴或資料流**
（邊界圖的重點常常是「什麼不允許」）。

每篇 pattern 文件的結構固定：

1. **Pattern 一句話**（引言區塊）——只讀這行就能決定要不要往下讀；
2. **問題**——什麼情境會遇到；
3. **Pattern**——通用的設計細節；
4. **評估**——為什麼值得學、哪一句最值得帶走；
5. **Trade-offs**——代價與不適用的情況；
6. **本專案中的實例**——連回現況契約與原始碼（唯一與本 codebase 綁定的小節）。

### 建議閱讀順序

**入口**

0. [系統總覽：整體架構與端到端 data flow](./system-design/system-overview.md)

**基礎（先讀，其他文件會引用它們的概念）**

1. [模組邊界：所有權表、單向依賴與機器強制](./system-design/module-boundaries.md)
2. [第三方引擎的 Adapter 邊界](./system-design/third-party-engine-adapter.md)
3. [封閉結果型別與純決策函式](./system-design/typed-results-and-pure-decisions.md)

**資料與一致性**

4. [Transactional Outbox：跨系統一致性](./system-design/transactional-outbox.md)
5. [資料生命週期：保留矩陣、有界 GC 與並發安全的刪除](./system-design/data-lifecycle-and-gc.md)
6. [版本與相容性：每種格式一個版本號](./system-design/versioning-and-compatibility.md)

**安全**

7. [分層授權：每層一種機制、每跳重新驗證](./system-design/layered-authorization.md)
8. [瀏覽器端 E2EE 與金鑰生命週期](./system-design/e2ee-key-lifecycle.md)
9. [CSP 與 Code Delivery：以通道為單位收斂](./system-design/csp-and-code-delivery.md)
10. [防禦性邊界：輸入界限、資源上限與 fail-open/fail-closed](./system-design/defensive-boundaries.md)

**分散式與即時系統**

11. [即時協作房間：Coordination Atom、Thin Gateway 與收斂式恢復](./system-design/realtime-room-coordination.md)
12. [Client 寫入節奏與 writer 選舉：cadence cooldown、notBefore 與最後一筆寫入](./system-design/client-write-pacing-and-writer-election.md)
13. [成本感知的有狀態服務：可休眠 actor 的 liveness](./system-design/cost-aware-stateful-services.md)
14. [上限是防護，不是容量](./system-design/limits-as-protection-not-capacity.md)
15. [隱私安全的 Observability](./system-design/privacy-safe-observability.md)

**前端架構**

16. [持久工作區與 URL-Addressable Overlay](./system-design/persistent-shell-overlay-routing.md)
17. [遠端狀態回灌的重入抑制：引用計數的 dirty-tracking suppression](./system-design/reentrancy-suppression-for-echoed-remote-state.md)
18. [Server 端解析狀態的 Hydration 邊界](./system-design/hydration-boundary-for-server-resolved-state.md)

**工程流程（橫切所有主題）**

19. [Config 與部署是受測工件](./system-design/config-and-deployment-as-artifacts.md)
20. [測試作為契約](./system-design/testing-as-contracts.md)
21. [演進與清理紀律](./system-design/evolution-and-cleanup.md)
22. [記錄下來的拒絕：把「刻意不做」寫成決策](./system-design/recorded-refusals.md)

趕時間的話，最高槓桿的五篇：**模組邊界、Transactional Outbox、防禦性邊界、
測試作為契約、記錄下來的拒絕**。（Adapter 邊界仍是本專案槓桿最大的單一決策，
但只在「產品建立在一個大型第三方引擎上」時適用；記錄下來的拒絕零成本、任何專案
第一天就能用，所以趕時間時優先讀它。）

## 如何讀現況契約（本專案開發者）

入口是 [architecture contract](./architecture/architecture-contract.md)：
它定義模組所有權、依賴圖與上游邊界，其他文件都從它輻射出去。

| 你要做的事 | 先讀 |
| --- | --- |
| 動 Excalidraw 整合 | [architecture contract](./architecture/architecture-contract.md) → [ADR 0001](./adr/0001-excalidraw-persistence-boundary.md) → [native UI integration contract](./architecture/native-ui-integration-contract.md) |
| 動協作功能 | [collaboration system design](./architecture/collaboration-system-design.md) → [threat model](./architecture/collaboration-threat-model.md) → [SLO](./performance/collaboration-slo-capacity.md) |
| 動資料保留／刪除 | [data lifecycle](./architecture/data-lifecycle.md) |
| 動 DB schema、清理舊碼 | [engineering conventions](./operations/engineering-conventions.md) |
| 動 headers／CSP／embed | [web CSP design](./architecture/web-csp-design.md) → [ADR-0004](./adr/0004-code-delivery-trust-boundary.md) → [web security headers](./operations/web-security-headers.md) |
| 動路由／overlay | [workspace overlay routing](./architecture/workspace-overlay-routing-system-design.md) |
| 動 DO 部署／監控 | [DO deployment](./operations/collaboration-do-deployment.md) → [DO observability](./observability/collaboration-do-observability.md) |
| 動效能敏感路徑 | `performance/` 內對應的 budget 文件（數字的唯一來源） |

ADR 是決策紀錄（含被拒絕的替代方案），被取代時就地標注並指向後繼，不刪除；
`architecture/` 是可執行的現況，會隨系統更新。兩者遇到衝突時，以
`architecture/` 的現況文件為準，並回頭修正標注。
