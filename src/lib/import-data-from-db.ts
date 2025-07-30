import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";

export async function importDataFromBackend(
  id: string,
  decryptionKey: string,
): Promise<ImportedDataState> {
  try {
    // TODO: 這邊是從後端取得資料，先註解掉
    // const response = await fetch(`${BACKEND_V2_GET}${id}`);

    // if (!response.ok) {
    //   window.alert(t("alerts.importBackendFailed"));
    //   return {};
    // }
    // const buffer = await response.arrayBuffer();

    const data = {
      elements: [],
      appState: null,
    };
    // TODO: 這邊是解壓縮資料，先註解掉
    // const { data: decodedBuffer } = await decompressData(
    //   new Uint8Array(buffer),
    //   {
    //     decryptionKey,
    //   },
    // );
    // const data: ImportedDataState = JSON.parse(
    //   new TextDecoder().decode(decodedBuffer),
    // );

    return {
      elements: data.elements ?? null,
      appState: data.appState ?? null,
    };
  } catch (error: unknown) {
    // window.alert(t("alerts.importBackendFailed"));
    console.error("importFromBackend error", error);
    console.error(error);
    return {};
  }
}
