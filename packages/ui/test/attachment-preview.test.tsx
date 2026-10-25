import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Attachments } from "../src/components/Attachments.tsx";
import type { PendingFile } from "../src/useAttachments.ts";

const image = (name: string, type = "image/png"): PendingFile => ({ id: name, file: new File(["image"], name, { type }) });
function Draft({ initial }: { initial: PendingFile[] }) {
 const [files, setFiles] = useState(initial);
 return <Attachments files={files} locked={false} remove={(id) => setFiles((list) => list.filter((f) => f.id !== id))} />;
}

beforeEach(() => {
 let id = 0;
 vi.stubGlobal("URL", Object.assign(class extends URL {}, {
  createObjectURL: vi.fn(() => `blob:preview-${++id}`), revokeObjectURL: vi.fn(),
 }));
 Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
 vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("composer attachment previews", () => {
 it("shows image thumbnails and a compact file chip in one horizontal list", () => {
  render(<Draft initial={[image("photo.png"), image("other.jpg", "image/jpeg"), image("notes.txt", "text/plain")]} />);
  const list = screen.getByRole("list", { name: "Files to send" });
  expect(list).toHaveClass("attachment-preview-row");
  expect(within(list).getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["photo.png", "other.jpg"]);
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("notes.txt")).toBeVisible();
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
 });
 it("revokes only the removed thumbnail and revokes the remaining URL on unmount", () => {
  const view = render(<Draft initial={[image("a.png"), image("b.png")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Quitar a.png" }));
  expect(screen.queryByRole("img", { name: "a.png" })).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  expect(screen.getByRole("img", { name: "b.png" })).toBeVisible();
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-2");
 });
 it("opens the existing larger image viewer and closes without revoking the draft URL", () => {
  render(<Draft initial={[image("photo.png")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Ver photo.png" }));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute("src", "blob:preview-1");
  fireEvent.click(screen.getByRole("button", { name: /Cerrar/ }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
 });
 it("falls back to a removable file chip when HEIC cannot decode", () => {
  render(<Draft initial={[image("photo.heic", "image/heic")]} />);
  fireEvent.error(screen.getByRole("img", { name: "photo.heic" }));
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("photo.heic")).toBeVisible();
  expect(screen.getByRole("button", { name: "Quitar photo.heic" })).toBeEnabled();
 });
 it("does not recreate URLs for progress updates and revokes replaced files", () => {
  const first = image("photo.png");
  const view = render(<Attachments files={[first]} locked={false} remove={vi.fn()} />);
  view.rerender(<Attachments files={[{ ...first, progress: 0.3 }]} locked remove={vi.fn()} />);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  view.rerender(<Attachments files={[{ ...image("other.png"), id: first.id }]} locked={false} remove={vi.fn()} />);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  expect(screen.getByRole("img", { name: "other.png" })).toHaveAttribute("src", "blob:preview-2");
 });
 it("cleans up StrictMode previews without leaking the replayed URL", () => {
  const view = render(<StrictMode><Draft initial={[image("photo.png")]} /></StrictMode>);
  expect(screen.getByRole("img")).toHaveAttribute("src", "blob:preview-2");
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
 });
 it("keeps progress, errors, and upload locking available", () => {
  render(<Attachments files={[{ ...image("photo.png"), progress: 0.5, error: "Upload failed" }]} locked remove={vi.fn()} />);
  expect(screen.getByRole("progressbar", { name: "Uploading photo.png" })).toHaveAttribute("value", "0.5");
  expect(screen.getByRole("alert")).toHaveTextContent("Upload failed");
  expect(screen.getByRole("button", { name: "Quitar photo.png" })).toBeDisabled();
 });
});
