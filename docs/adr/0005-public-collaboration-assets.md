# ADR-0005：共編附件暫時維持 public 密文物件

- Status: Accepted（2026-10-07，擁有者決定）
- 範圍：共編附件 provider 存取契約；不改變房間 E2EE、索引或寫入授權。

UploadThing 維持現有 public 上傳。附件由瀏覽器加密，服務端不接收房間秘密或明文。
應用 API 仍檢查最新房間權限後提供附件索引／URL、核准上傳與確認登記；撤權後拒絕這些受控入口。

已取得或由他人另行交付的永久物件 URL，在物件刪除前仍能直接下載密文。
持有對應金鑰的人仍可解密，已下載的副本不能收回。這是暫時接受的 provider 層限制；
`enforced` 不代表這些 URL 失效，不宣稱附件下載權與房間成員權限同步撤回。

本次不要求私有上傳、下載代理、預簽 URL、付費升級或更換儲存服務。
因此私有附件能力不再是 [授權契約](../architecture/collaboration-authority.md) 或部署 gate。
若日後需要 provider 層的下載撤權，另立計畫評估，不將 public ACL 的接受範圍擴大成明文可公開。

目前行為與威脅範圍見 [共編儲存契約](../architecture/collaboration-storage.md) 與
[威脅模型](../architecture/collaboration-threat-model.md)。

## 後續變更（2026-10-09）

[Plan 19](../../plans/19-server-room-key-custody.md) 依擁有者決定由 Room DO 包裝保管房間金鑰，
上文「服務端不接收房間秘密」與「房間 E2EE」已不再成立：附件仍只在瀏覽器加密、UploadThing 仍不持有金鑰，
但服務端可經保管副本解密；撤權後成員無法再向保管取得金鑰。本 ADR 對 public 物件 URL 的接受範圍不變。
