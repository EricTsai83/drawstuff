# Learning：學習文章索引

這裡集中可在瀏覽器開啟的獨立 HTML 文章。目錄裡有兩種性質不同的文章，讀之前先分清楚：

| 類型 | 性質 | 與正式契約的關係 |
| --- | --- | --- |
| **學習文章** | 解說可轉移的設計與取捨，可能比較現況、候選方案或**尚未實作的目標設計** | 不是實作已完成的證明；請看各篇標示的狀態與查核日期 |
| **導讀** | 解釋某份正式契約在回答什麼問題、每章為什麼存在、最容易誤解的地方 | **不重述契約裡的門檻數字或規格**；權威一律是被導讀的 Markdown |

導讀刻意不含數字。一份被複製到兩個地方的門檻值，一定會有一天只有其中一份被更新，而且沒有任何檢查
會發現——所以這裡不放第二份。

現況契約仍在 `../architecture/`、`../operations/`、`../performance/` 等目錄；待執行工作在根目錄 `plans/`。

## 協作架構學習系列（目標設計，尚未實作）

建議按下列順序閱讀；每篇也提供背景，可單獨閱讀。最終契約與驗收在
[Plan 18B](../../plans/18b-collaboration-authority-reset.md)。

| 文章 | 想解答的問題 |
| --- | --- |
| [協作架構選型](serverless-collaboration-production.html) | 現況與目標架構差在哪裡？為什麼選混合架構？包含兩張架構圖與 tldraw 對照。 |
| [持久待辦與 alarm](durable-outbox-and-alarms.html) | 程序結束後，工作如何恢復？為何不需要每分鐘查 Neon？ |
| [Serverless 儲存與成本](serverless-storage-and-cost.html) | DO 多存什麼？Free 額度怎麼看？休眠為何不等於儲存免費？ |
| [協作授權與金鑰](collaboration-authorization-and-keys.html) | 踢人如何涵蓋存檔／附件？有房間列表為何還需要金鑰？故障下能保證什麼？ |

## 學習文章

| 文章 | 主題 |
| --- | --- |
| [瀏覽器 E2EE 與 Excalidraw](browser-e2ee-excalidraw.html) | 共享金鑰的 capability link 與 opaque relay：成立條件、Excalidraw 上游實作對照，以及搬進有權限產品時要補的四份契約。 |

## 導讀（不含數字，權威在 Markdown）

| 導讀 | 被導讀的契約 | 回答什麼 |
| --- | --- | --- |
| [協作系統設計怎麼讀](collaboration-system-design.html) | [architecture/collaboration-system-design.md](../architecture/collaboration-system-design.md) | 責任怎麼分工、為什麼授權撤銷與密碼學撤銷分開、join 為什麼先訂閱再載入。 |
| [共編 SLO 與 capacity 怎麼讀](collaboration-slo-capacity.html) | [performance/collaboration-slo-capacity.md](../performance/collaboration-slo-capacity.md) | safety limit 為什麼不是容量承諾、上限為何以 room 為界、限流為何 fail open。 |

## 撰寫規則

- 新增文章放在此目錄，於本索引說明主題與類型；保留可獨立閱讀的背景，並連回正式契約或 plan。
- 學習文章按主題拆分，避免一篇同時承載架構、排程、成本和密碼學的完整論述。
- **導讀不得重述門檻數字、上限或版本值。** 需要具體數字時，連回 Markdown 契約。
- 每篇在標題下方標示類型、狀態與查核日期，讓讀者知道它描述的是現況還是目標設計。
- 樣式共用 [`learning.css`](learning.css)（相對路徑 `<link>`，用 `file://` 直接開啟也會套用，
  前提是保留本目錄結構）。`browser-e2ee-excalidraw.html` 的版面與導覽結構不同，刻意保留自己的內嵌樣式。
