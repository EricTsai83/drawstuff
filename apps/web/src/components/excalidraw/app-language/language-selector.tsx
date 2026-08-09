import { useAppI18n } from "@/hooks/use-app-i18n";
import { allowedLanguages } from "./allowed-languages";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dropdown } from "@/components/icons/dropdown";
import { cn } from "@/lib/utils";

const languageItems = allowedLanguages.map(({ code, label }) => ({
  label,
  value: code,
}));

export const LanguageSelector = ({
  value,
  onValueChange,
  open,
  onOpenChange,
}: {
  value: string;
  onValueChange: (langCode: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  const { t } = useAppI18n();
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const handleOpenChange = (nextOpen: boolean) => {
    if (onOpenChange) onOpenChange(nextOpen);
    else setInternalOpen(nextOpen);
  };

  return (
    <Select
      items={languageItems}
      modal={false}
      onValueChange={(langCode) => {
        if (langCode !== null) onValueChange(langCode);
      }}
      value={value}
      open={isOpen}
      onOpenChange={handleOpenChange}
    >
      <SelectTrigger
        aria-label={t("buttons.selectLanguage")}
        size="sm"
        className="h-7 w-full gap-1 px-2 py-1 text-[13px]"
        icon={
          <Dropdown
            className={cn(
              "pointer-events-none size-2 transition-transform duration-300 ease-in-out select-none",
              isOpen ? "rotate-180" : undefined,
            )}
            aria-hidden="true"
          />
        }
      >
        <SelectValue placeholder={t("buttons.selectLanguage")} />
      </SelectTrigger>
      <SelectContent data-prevent-outside-click>
        <SelectGroup>
          {languageItems.map((lang) => (
            <SelectItem
              key={lang.value}
              value={lang.value}
              className="py-1 pr-6 pl-2 text-xs"
            >
              {lang.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};
