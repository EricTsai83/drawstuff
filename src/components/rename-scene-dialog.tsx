import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MainMenu, THEME, useI18n } from "@excalidraw/excalidraw";
import { useRef } from "react";
import type { Theme } from "@excalidraw/excalidraw/element/types";
import { Pencil } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export function RenameSceneDialog({
  editorTheme,
  excalidrawAPI,
}: {
  editorTheme: Theme | "system";
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <MainMenu.Item
          className="!mt-0"
          data-testid="rename-scene-menu-item"
          icon={<Pencil />}
          onSelect={(event) => {
            event.preventDefault();
            console.log("Rename");
          }}
          aria-label={t("labels.fileTitle")}
        >
          {t("labels.fileTitle")}
        </MainMenu.Item>
      </DialogTrigger>
      <DialogContent
        className={`rounded-xl border px-6 py-5 sm:max-w-md ${
          editorTheme === THEME.DARK
            ? "border-[#393943] bg-[#232329] text-white"
            : "border-[#e5e5ea] bg-white text-gray-900"
        }`}
        onOpenAutoFocus={(e) => e.preventDefault()}
        data-prevent-outside-click="true"
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("labels.fileTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("labels.fileTitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid flex-1 gap-2">
          <Label htmlFor="link" className="sr-only">
            {t("labels.fileTitle")}
          </Label>
          <Input
            ref={inputRef}
            id="link"
            defaultValue={excalidrawAPI?.getName()}
            readOnly
            className={
              editorTheme === THEME.DARK
                ? "border-[#393943] bg-[#232329] text-white"
                : "border-[#e5e5ea] bg-white text-gray-900"
            }
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// export function RenameScene() {
//   const { t } = useI18n();

//   return (
//     <MainMenu.Item
//       data-testid="rename-scene-menu-item"
//       icon={<Pencil />}
//       onSelect={() => {
//         console.log("Rename");
//       }}
//       aria-label={t("labels.fileTitle")}
//     >
//       {t("labels.fileTitle")}
//     </MainMenu.Item>
//   );
// }
