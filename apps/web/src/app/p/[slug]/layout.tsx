import type { ReactNode } from "react";

// 公開 viewer 的畫布字型：`exportSceneToSvg` 以 `skipInliningFonts` 匯出，SVG 的
// `<text font-family>` 靠這份 build 時從 woff2 產生的 `@font-face`（含
// unicode-range）解析，瀏覽器只下載文字實際用到的檔案。只掛在 /p 底下：工作區由
// 上游 FontFace API 自行註冊同一批檔案，不需要第二份宣告。`precedence` 讓 React
// 把 link hoist 進 <head> 並在 client 端等它載入完再顯示子樹。
export default function PublishedSceneLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      {/* 生成物在 public/，不走 CSS import：內容隨字型檔變動且沒有雜湊檔名，
          刻意維持 Next 預設 max-age=0 + ETag（next.config.ts）。 */}
      {/* eslint-disable-next-line @next/next/no-css-tags */}
      <link
        rel="stylesheet"
        href="/excalidraw-assets/fonts.css"
        precedence="excalidraw-fonts"
      />
      {children}
    </>
  );
}
