import {
  Avatar as AvatarWrapper,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";

export function Avatar({ src, fallback }: { src: string; fallback: string }) {
  return (
    <AvatarWrapper>
      <AvatarImage src={src} />
      <AvatarFallback>{fallback}</AvatarFallback>
    </AvatarWrapper>
  );
}
