"use client";

// Reference: https://shadcnui-expansions.typeart.cc/docs/multiple-selector
import MultipleSelector, {
  type Option,
} from "@/components/ui/multiple-selector";
import { api } from "@/trpc/react";
import { toast } from "sonner";

function SearchableAndCreatableSelector({
  value,
  onChange,
}: {
  value?: Option[];
  onChange?: (value: Option[]) => void;
}) {
  const utils = api.useUtils();

  const handleSearch = async (keyword: string) => {
    try {
      const categories = await utils.category.list.fetch(undefined, {
        staleTime: 30_000,
      });
      const term = keyword.trim().toLowerCase();
      return categories
        .filter((categoryItem) =>
          term ? categoryItem.name.toLowerCase().includes(term) : true,
        )
        .map((categoryItem) => ({
          value: categoryItem.name,
          label: categoryItem.name,
        }));
    } catch {
      toast.error("Failed to get categories", {
        duration: Infinity,
        closeButton: true,
      });
      return [];
    }
  };

  return (
    <div className="flex w-full flex-col gap-5">
      <MultipleSelector
        hideClearAllButton
        value={value}
        onChange={onChange}
        onSearch={handleSearch}
        defaultOptions={[]}
        creatable
        placeholder="Type or create a category"
        loadingIndicator={
          <p className="text-muted-foreground py-2 text-center text-lg leading-10">
            Searching...
          </p>
        }
        emptyIndicator={
          <p className="text-muted-foreground w-full text-center text-lg leading-10">
            No matching results.
          </p>
        }
      />
    </div>
  );
}

export default SearchableAndCreatableSelector;
