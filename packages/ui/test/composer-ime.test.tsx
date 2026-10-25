import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.tsx";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ mobile, controlled }: { mobile: boolean; controlled: boolean }) {
 const [text, setText] = useState("");
 return <Composer mobile={mobile} busy={false} disabled={false} send={vi.fn()}
  {...(controlled ? { text, onText: setText } : {})} />;
}

it.each([false, true])("keeps the textarea and caret across keyboard viewport/layout changes (controlled=%s)", controlled => {
 const view = render(<Harness mobile={false} controlled={controlled} />);
 const box = screen.getByRole("textbox") as HTMLTextAreaElement;
 box.focus();
 for (const [index, letter] of [..."abc"].entries()) {
  const caret = box.selectionStart;
  const value = box.value.slice(0, caret) + letter + box.value.slice(box.selectionEnd);
  fireEvent.change(box, { target: { value, selectionStart: caret + 1, selectionEnd: caret + 1 } });
  vi.stubGlobal("innerHeight", index % 2 === 0 ? 320 : 800);
  vi.stubGlobal("innerWidth", index % 2 === 0 ? 375 : 1024);
  fireEvent(window, new Event("resize"));
  view.rerender(<Harness mobile={index % 2 === 0} controlled={controlled} />);
  expect(screen.getByRole("textbox")).toBe(box);
  expect(document.activeElement).toBe(box);
  expect(box.selectionStart).toBe(index + 1);
 }
 expect(box.value).toBe("abc");
 box.setSelectionRange(1, 1);
 fireEvent(window, new Event("resize"));
 view.rerender(<Harness mobile={false} controlled={controlled} />);
 expect(box.selectionStart).toBe(1);
 fireEvent.change(box, { target: { value: box.value.slice(0, box.selectionStart) + "X" + box.value.slice(box.selectionEnd), selectionStart: 2, selectionEnd: 2 } });
 expect(box.value).toBe("aXbc");
});
