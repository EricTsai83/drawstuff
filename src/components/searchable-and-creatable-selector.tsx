"use client";

// Reference: https://shadcnui-expansions.typeart.cc/docs/multiple-selector
import MultipleSelector, {
  type Option,
} from "@/components/ui/multiple-selector";
import { getCourseCategory } from "@/server/actions";
import { toast } from "sonner";

function SearchableAndCreatableSelector({
  value,
  onChange,
}: {
  value?: Option[];
  onChange?: (value: Option[]) => void;
}) {
  const handleSearch = async (keyword: string) => {
    try {
      const response = await getCourseCategory(keyword);
      if (response.status === "failed") {
        toast.error(response.message);
        return [];
      }
      if (response.status === "success" && response.data) {
        return response.data;
      }
      return [];
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
        placeholder="自由填寫類別"
        loadingIndicator={
          <p className="text-muted-foreground py-2 text-center text-lg leading-10">
            搜尋中...
          </p>
        }
        emptyIndicator={
          <p className="text-muted-foreground w-full text-center text-lg leading-10">
            沒有找到相符結果。
          </p>
        }
      />
    </div>
  );
}

export default SearchableAndCreatableSelector;
