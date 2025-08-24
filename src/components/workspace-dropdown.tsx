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
import { ChevronDown, CheckIcon, FolderOpen } from "lucide-react";

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
    placeholder = "Select a workspace",
    slim = false,
    ...props
  }: WorkspaceDropdownProps,
  ref: React.ForwardedRef<HTMLButtonElement>,
) {
  const [open, setOpen] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<
    Workspace | undefined
  >(undefined);

  useEffect(() => {
    if (defaultValue) {
      const initial = options.find((it) => it.id === defaultValue);
      if (initial) {
        setSelectedWorkspace(initial);
      } else {
        setSelectedWorkspace(undefined);
      }
    } else {
      setSelectedWorkspace(undefined);
    }
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

  const triggerClasses = cn(
    "flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
    slim === true && "w-20",
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={ref}
        className={triggerClasses}
        disabled={disabled}
        {...props}
      >
        {selectedWorkspace ? (
          <div className="flex w-0 flex-grow items-center gap-2 overflow-hidden">
            <div className="inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
              <FolderOpen size={20} className="text-muted-foreground" />
            </div>
            {slim === false && (
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {selectedWorkspace.name}
              </span>
            )}
          </div>
        ) : (
          <span>
            {slim === false ? (
              placeholder
            ) : (
              <FolderOpen size={20} className="text-muted-foreground" />
            )}
          </span>
        )}
        <ChevronDown size={16} />
      </PopoverTrigger>
      <PopoverContent
        collisionPadding={10}
        side="bottom"
        className="min-w-[--radix-popper-anchor-width] p-0"
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
                      <div className="inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full">
                        <FolderOpen
                          size={20}
                          className="text-muted-foreground"
                        />
                      </div>
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
