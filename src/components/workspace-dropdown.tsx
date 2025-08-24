"use client";

import { useCallback, useState, forwardRef, useEffect } from "react";
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
import { CheckIcon } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { Dropdown } from "./icons";

export type Workspace = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
};

type WorkspaceDropdownProps = {
  options?: Workspace[];
  onChange?: (workspace: Workspace) => void;
  defaultValue?: string;
  disabled?: boolean;
  placeholder?: string;
  slim?: boolean;
};

function WorkspaceDropdownComponent(
  {
    options = [],
    onChange,
    defaultValue,
    disabled = false,
    slim = false,
    ...props
  }: WorkspaceDropdownProps,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const [open, setOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<
    Workspace | undefined
  >(undefined);
  const { data: session } = authClient.useSession();
  const sessionDisplayName = (session?.user?.name ?? "").trim();
  const sessionDefaultLabel = sessionDisplayName
    ? `${sessionDisplayName}'s workspace`
    : undefined;

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
      console.log("📁 WorkspaceDropdown value: ", workspace);
      setSelectedWorkspace(workspace);
      onChange?.(workspace);
      setOpen(false);
    },
    [onChange],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={ref}
        className={cn(
          "border-input ring-offset-background placeholder:text-muted-foreground flex h-8 w-full items-center justify-between border-b-2 bg-transparent px-3 py-2 text-sm whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
          slim === true && "w-20",
        )}
        disabled={disabled}
        aria-label={`Current workspace: ${
          selectedWorkspace?.name ??
          sessionDefaultLabel ??
          options[0]?.name ??
          "None"
        }`}
        {...props}
      >
        <div className="flex w-0 flex-grow items-center gap-2 overflow-hidden">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">
            {selectedWorkspace?.name ?? sessionDefaultLabel ?? ""}
          </span>
        </div>

        <Dropdown
          className={cn(
            "w-2 transition-transform duration-300 ease-in-out",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </PopoverTrigger>
      <PopoverContent
        collisionPadding={10}
        side="bottom"
        className="w-auto min-w-[var(--radix-popper-anchor-width)] p-0"
      >
        <Command className="max-h-[200px] w-full sm:max-h-[270px]">
          <CommandList>
            <div className="bg-popover sticky top-0 z-10">
              <CommandInput placeholder="Search workspace..." />
            </div>
            <CommandEmpty>No workspace found.</CommandEmpty>
            <CommandGroup>
              {options
                .filter((x) => x.name)
                .map((option, key: number) => (
                  <CommandItem
                    className="flex w-full items-center gap-2"
                    key={key}
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
  );
}

WorkspaceDropdownComponent.displayName = "WorkspaceDropdownComponent";

export const WorkspaceDropdown = forwardRef(WorkspaceDropdownComponent);
