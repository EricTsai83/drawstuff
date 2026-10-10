# ADR-0005：共編附件是 public 明文物件

- Status: Accepted（2026-10-10，擁有者決定；[plan 21](../../plans/21-plain-rooms-google-docs-access.md) D6）
- 範圍：共編附件的儲存格式與 provider 存取契約；不改變附件索引或寫入授權。

## 決定

房間圖片不加密，沿用 UploadThing public 上傳：物件內容就是 `encodeCollaborationAssetPayload`
的明文 bytes（payload version、metadata、data URL），暴露程度與「我的場景」的圖片相同。
共編房間整體不做端對端加密，以登入與房間權限保護（plan 21 D1）。

應用 API 檢查最新房間權限後才提供附件索引／URL、核准上傳與確認登記；撤權後拒絕這些受控入口。
已取得或由他人另行交付的永久物件 URL，在物件刪除前仍能直接下載內容，已下載的副本不能收回。
`enforced` 不代表這些 URL 失效，不宣稱附件下載權與房間權限同步撤回。物件在房間結束的
cleanup（或保留期回收）時刪除。

## 理由

產品其他部分本來就不加密：本機自動存檔、「我的場景」與其圖片（UploadThing public URL）、發布。
只有分享連結需要端對端加密。房間圖片採同一種保護方式，不需要房間金鑰，也讓房間與個人場景的
暴露程度一致。

## 不做

私有上傳、下載代理、預簽 URL、付費升級或更換儲存服務都不在範圍內，也不是
[授權契約](../architecture/collaboration-authority.md) 或部署 gate。若日後需要 provider 層的下載撤權，
應同時評估個人場景圖片，另立計畫。

目前行為與威脅範圍見 [共編儲存契約](../architecture/collaboration-storage.md) 與
[威脅模型](../architecture/collaboration-threat-model.md)。
