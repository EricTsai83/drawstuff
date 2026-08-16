"use client";

import { useCallback, useState, forwardRef, useMemo } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { CheckIcon, Plus } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { Dropdown } from "./icons";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { useAppI18n } from "@/hooks/use-app-i18n";

export type Workspace = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

// 依優先 ID（selected / lastActive）將目標搬到陣列最前
function getSortedOptions(
  options: Workspace[],
  selectedId?: string,
  lastActiveId?: string,
) {
  if (!options || options.length === 0) return [];
  const prioritizedId = selectedId ?? lastActiveId;
  if (!prioritizedId) return options;
  const idx = options.findIndex((option) => option.id === prioritizedId);
  if (idx <= 0) return options;
  return [options[idx]!, ...options.slice(0, idx), ...options.slice(idx + 1)];
}

type WorkspaceDropdownProps = {
  options?: Workspace[];
  onChange?: (workspace: Workspace) => void;
  value?: string;
  disabled?: boolean;
  slim?: boolean;
  // 顯示固定在清單頂端的完整建立流程入口
  onCreateAction?: () => void;
};

function WorkspaceDropdownComponent(
  {
    options = [],
    onChange,
    value,
    disabled = false,
    slim = false,
    onCreateAction,
    ...restProps
  }: WorkspaceDropdownProps,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const { t } = useAppI18n();
  const [open, setOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [highlightedValue, setHighlightedValue] = useState("");
  const { data: session } = authClient.useSession();
  const { lastActiveWorkspaceId } = useWorkspaceOptions();
  const sessionDisplayName = (session?.user?.name ?? "").trim();
  const sessionDefaultLabel = sessionDisplayName
    ? `${sessionDisplayName}'s workspace`
    : undefined;

  const normalizedQuery = searchValue.trim();
  const selectedWorkspace = useMemo(
    () => options.find((option) => option.id === value),
    [options, value],
  );

  const sortedOptions = useMemo(
    () =>
      getSortedOptions(options, selectedWorkspace?.id, lastActiveWorkspaceId),
    [options, selectedWorkspace?.id, lastActiveWorkspaceId],
  );

  const triggerLabel = selectedWorkspace?.name ?? sessionDefaultLabel ?? "";

  const handleSelect = useCallback(
    (workspace: Workspace) => {
      onChange?.(workspace);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          ref={ref}
          className={cn(
            "border-input ring-offset-background placeholder:text-muted-foreground flex h-8 w-full items-center justify-between border-b-2 bg-transparent px-3 py-2 text-sm whitespace-nowrap hover:cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
            "focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none",
            slim === true && "w-20",
          )}
          disabled={disabled}
          aria-label={t("workspace.current", {
            name: triggerLabel ?? options[0]?.name ?? t("workspace.none"),
          })}
          {...restProps}
        >
          <div className="flex w-0 grow items-center gap-2 overflow-hidden">
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {triggerLabel}
            </span>
          </div>

          <Dropdown
            className={cn(
              "pointer-events-none w-2 transition-transform duration-300 ease-in-out select-none",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </PopoverTrigger>
        <PopoverContent
          collisionPadding={10}
          side="bottom"
          className="w-(--anchor-width) p-0"
          data-prevent-outside-click
        >
          <Command
            value={highlightedValue}
            onValueChange={setHighlightedValue}
            className={cn(
              "w-full",
              onCreateAction
                ? "max-h-[240px] sm:max-h-[310px]"
                : "max-h-[200px] sm:max-h-[270px]",
            )}
            filter={(value, search, keywords) => {
              const q = (search ?? "").trim().toLowerCase();
              if (q.length === 0) return 1;
              return [value, ...(keywords ?? [])].some((candidate) =>
                candidate.toLowerCase().includes(q),
              )
                ? 1
                : 0;
            }}
          >
            <div className="bg-popover">
              <CommandInput
                placeholder={t("workspace.placeholder.search")}
                value={searchValue}
                onValueChange={(val) => setSearchValue(val)}
                autoFocus
                onKeyDown={(e) => {
                  const nativeEvt = e.nativeEvent as unknown as {
                    isComposing?: boolean;
                  };
                  const isComposing = Boolean(nativeEvt?.isComposing);
                  if (e.key === "Enter" && isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }}
                className={cn(
                  "focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:outline-none",
                )}
              />
            </div>
            <CommandList
              className={cn(
                onCreateAction
                  ? "max-h-none overflow-hidden"
                  : "max-h-[200px] overflow-y-auto sm:max-h-[270px]",
              )}
              onWheelCapture={(e) => {
                e.stopPropagation();
              }}
            >
              {onCreateAction && normalizedQuery.length === 0 && (
                <>
                  <CommandGroup forceMount>
                    <CommandItem
                      value="create-workspace"
                      keywords={[t("dashboard.workspace.create")]}
                      className="hover:bg-accent hover:text-accent-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground hover:cursor-pointer [&>svg:last-child]:hidden"
                      onSelect={() => {
                        setSearchValue("");
                        setOpen(false);
                        onCreateAction();
                      }}
                    >
                      <Plus />
                      <span>{t("dashboard.workspace.create")}</span>
                    </CommandItem>
                  </CommandGroup>
                  <Separator />
                </>
              )}
              <div
                className={cn(
                  onCreateAction &&
                    (normalizedQuery.length === 0
                      ? "max-h-[160px] overflow-y-auto sm:max-h-[230px]"
                      : "max-h-[200px] overflow-y-auto sm:max-h-[270px]"),
                )}
              >
                <CommandEmpty>{t("workspace.empty")}</CommandEmpty>
                <CommandGroup>
                  {sortedOptions
                    .filter((x) => x.name)
                    .map((option) => {
                      const isSelected = option.id === selectedWorkspace?.id;

                      return (
                        <CommandItem
                          value={option.id}
                          keywords={[option.name, option.description ?? ""]}
                          className={cn(
                            "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground flex w-full items-center gap-2 [&>svg:last-child]:hidden",
                            isSelected
                              ? "bg-accent text-accent-foreground data-[disabled=true]:pointer-events-auto data-[disabled=true]:opacity-100"
                              : "hover:bg-accent hover:text-accent-foreground hover:cursor-pointer",
                          )}
                          key={option.id}
                          disabled={isSelected}
                          aria-current={isSelected ? "true" : undefined}
                          onPointerEnter={
                            isSelected
                              ? () => setHighlightedValue(option.id)
                              : undefined
                          }
                          onSelect={
                            isSelected ? undefined : () => handleSelect(option)
                          }
                        >
                          <div className="flex min-w-0 flex-1 gap-2 overflow-hidden">
                            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                              <span className="truncate font-medium">
                                {option.name}
                              </span>
                              {option.description && (
                                <span className="text-muted-foreground truncate text-xs">
                                  {option.description}
                                </span>
                              )}
                            </div>
                          </div>
                          <CheckIcon
                            className={cn(
                              "ml-auto shrink-0",
                              isSelected ? "opacity-100" : "opacity-0",
                            )}
                          />
                        </CommandItem>
                      );
                    })}
                </CommandGroup>
              </div>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}

WorkspaceDropdownComponent.displayName = "WorkspaceDropdownComponent";

export const WorkspaceDropdown = forwardRef(WorkspaceDropdownComponent);
