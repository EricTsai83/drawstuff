"use client";

import { useCallback, useState, forwardRef, useEffect, useMemo } from "react";
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
import { cn } from "@/lib/utils";
import { CheckIcon, Plus, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { authClient } from "@/lib/auth/client";
import { Dropdown } from "./icons";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";

export type Workspace = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

// 判斷是否可建立新 workspace
function canCreateWorkspace(normalizedQuery: string, options: Workspace[]) {
  if (normalizedQuery.length === 0) return false;
  const query = normalizedQuery.toLowerCase();
  return !options.some((option) => option.name.toLowerCase() === query);
}

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
  defaultValue?: string;
  disabled?: boolean;
  placeholder?: string;
  slim?: boolean;
  // 若提供，將顯示「建立新 Workspace」的選項，並在建立完成後自動選取
  onCreate?: (name: string) => Promise<Workspace | void> | Workspace | void;
};

function WorkspaceDropdownComponent(
  {
    options = [],
    onChange,
    defaultValue,
    disabled = false,
    slim = false,
    onCreate: _onCreate,
    placeholder = "Search workspace...",
    ...restProps
  }: WorkspaceDropdownProps,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const [open, setOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<
    Workspace | undefined
  >(undefined);
  const [searchValue, setSearchValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [confirmCreateOpen, setConfirmCreateOpen] = useState(false);
  const [pendingCreateName, setPendingCreateName] = useState<string | null>(
    null,
  );
  const { data: session } = authClient.useSession();
  const utils = api.useUtils();
  const createWorkspaceMutation = api.workspace.create.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
    },
  });
  const { lastActiveWorkspaceId } = useWorkspaceOptions();
  const sessionDisplayName = (session?.user?.name ?? "").trim();
  const sessionDefaultLabel = sessionDisplayName
    ? `${sessionDisplayName}'s workspace`
    : undefined;

  const normalizedQuery = searchValue.trim();

  const canCreate = useMemo(
    () => canCreateWorkspace(normalizedQuery, options),
    [normalizedQuery, options],
  );

  const sortedOptions = useMemo(
    () =>
      getSortedOptions(options, selectedWorkspace?.id, lastActiveWorkspaceId),
    [options, selectedWorkspace?.id, lastActiveWorkspaceId],
  );

  const triggerLabel = selectedWorkspace?.name ?? sessionDefaultLabel ?? "";

  useEffect(() => {
    if (options.length === 0) {
      setSelectedWorkspace(undefined);
      return;
    }

    if (defaultValue) {
      const match = options.find((it) => it.id === defaultValue);
      if (match) {
        setSelectedWorkspace((prev) => (prev?.id === match.id ? prev : match));
        return;
      }
    }

    // 預設不自動選第一個，保留 undefined 讓 Trigger 顯示 session 名稱
    setSelectedWorkspace((prev) => {
      if (!prev) return undefined;
      const stillExists = options.some((o) => o.id === prev.id);
      return stillExists ? prev : undefined;
    });
  }, [defaultValue, options]);

  const handleSelect = useCallback(
    (workspace: Workspace) => {
      setSelectedWorkspace(workspace);
      onChange?.(workspace);
      setOpen(false);
    },
    [onChange],
  );

  const handleCreate = useCallback(
    async (overrideName?: string) => {
      const name = (overrideName ?? normalizedQuery).trim();
      if (!name || creating) return;
      try {
        setCreating(true);
        const created = await createWorkspaceMutation.mutateAsync({ name });
        if (created?.id) {
          setSelectedWorkspace(created as Workspace);
          onChange?.(created as Workspace);
        }
      } catch (err) {
        toast.error((err as Error)?.message ?? "Failed to create workspace");
        return;
      } finally {
        setCreating(false);
        setSearchValue("");
        setOpen(false);
      }
    },
    [createWorkspaceMutation, onChange, normalizedQuery, creating],
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
          aria-label={`Current workspace: ${triggerLabel ?? options[0]?.name ?? "None"}`}
          {...restProps}
        >
          <div className="flex w-0 flex-grow items-center gap-2 overflow-hidden">
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
          className="w-auto min-w-[var(--radix-popper-anchor-width)] p-0"
          data-prevent-outside-click
        >
          <Command
            className="max-h-[200px] w-full sm:max-h-[270px]"
            filter={(value, search) => {
              const q = (search ?? "").trim().toLowerCase();
              if (q.length === 0) return 1;
              return value.toLowerCase().includes(q) ? 1 : 0;
            }}
          >
            <div className="bg-popover">
              <CommandInput
                placeholder={placeholder}
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
              className="max-h-[200px] overflow-y-auto sm:max-h-[270px]"
              onWheelCapture={(e) => {
                e.stopPropagation();
              }}
            >
              <CommandEmpty>No workspace found.</CommandEmpty>
              <CommandGroup>
                {canCreate && (
                  <CommandItem
                    value={normalizedQuery}
                    className={cn(
                      "flex w-full items-center gap-2",
                      "hover:bg-muted hover:text-foreground",
                      "data-[selected=true]:text-foreground data-[selected=true]:bg-transparent",
                      "data-[selected=true]:hover:bg-muted data-[selected=true]:hover:text-foreground",
                    )}
                    onSelect={() => {
                      if (creating) return;
                      setPendingCreateName(normalizedQuery);
                      setConfirmCreateOpen(true);
                    }}
                  >
                    <div className="flex w-0 flex-grow space-x-2 overflow-hidden">
                      <div className="flex flex-col overflow-hidden">
                        {creating ? (
                          <span className="overflow-hidden font-medium text-ellipsis whitespace-nowrap">
                            Creating...
                          </span>
                        ) : (
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap hover:cursor-pointer">
                            <span className="border-primary/30 bg-primary/10 text-primary inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm font-semibold">
                              <Plus className="h-3 w-3" />
                              Create
                            </span>
                            <span className="ml-2 font-medium">
                              {normalizedQuery}
                            </span>
                          </span>
                        )}
                      </div>
                    </div>
                  </CommandItem>
                )}
                {sortedOptions
                  .filter((x) => x.name)
                  .map((option) => (
                    <CommandItem
                      value={option.name}
                      className={cn(
                        "flex w-full items-center gap-2 hover:cursor-pointer",
                        option.id === selectedWorkspace?.id
                          ? "bg-accent text-primary-foreground hover:bg-accent hover:text-primary-foreground data-[selected=true]:bg-accent data-[selected=true]:text-primary-foreground"
                          : cn(
                              "hover:bg-muted hover:text-foreground",
                              "data-[selected=true]:text-foreground data-[selected=true]:bg-transparent",
                              "data-[selected=true]:hover:bg-muted data-[selected=true]:hover:text-foreground",
                            ),
                      )}
                      key={option.id}
                      onSelect={() => handleSelect(option)}
                    >
                      <div className="flex w-0 flex-grow space-x-2 overflow-hidden">
                        <div className="flex flex-col overflow-hidden">
                          <span className="overflow-hidden font-medium text-ellipsis whitespace-nowrap">
                            {option.name}
                          </span>
                          {option.description && (
                            <span className="text-muted-foreground overflow-hidden text-xs text-ellipsis whitespace-nowrap">
                              {option.description}
                            </span>
                          )}
                        </div>
                      </div>
                      <CheckIcon
                        className={cn(
                          "ml-auto h-4 w-4 shrink-0",
                          option.id === selectedWorkspace?.id
                            ? "opacity-100"
                            : "opacity-0",
                        )}
                      />
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <AlertDialog open={confirmCreateOpen} onOpenChange={setConfirmCreateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              This will create a new workspace named{" "}
              <span className="font-medium">{pendingCreateName}</span>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={creating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "flex items-center gap-2",
              )}
              autoFocus
              disabled={creating}
              aria-busy={creating}
              onClick={async (e) => {
                e.preventDefault();
                if (!pendingCreateName) return;
                await handleCreate(pendingCreateName);
                setConfirmCreateOpen(false);
                setPendingCreateName(null);
              }}
            >
              {creating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Creating...
                </>
              ) : (
                "Create"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

WorkspaceDropdownComponent.displayName = "WorkspaceDropdownComponent";

export const WorkspaceDropdown = forwardRef(WorkspaceDropdownComponent);
