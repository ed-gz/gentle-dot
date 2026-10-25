import { useEffect, useState } from "react";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);

export function isPreviewImage(file: Blob): boolean {
 return IMAGE_TYPES.has(file.type.toLowerCase());
}

/** A draft owns its preview for exactly as long as this File remains mounted. */
export function useAttachmentPreview(file: File): string | undefined {
 const [preview, setPreview] = useState<{ file: File; url: string }>();
 useEffect(() => {
  if (!isPreviewImage(file) || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(file);
  setPreview({ file, url });
  return () => URL.revokeObjectURL(url);
 }, [file]);
 return preview?.file === file ? preview.url : undefined;
}
