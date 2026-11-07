"use client";

import { useState } from "react";
import { setPilotToken } from "./api";
import { Button } from "./ui/button";

/** Pilot access-token entry, shown when the API answers 401. */
export function PilotTokenPrompt({ onUnlocked }: { onUnlocked: () => void }) {
  const [value, setValue] = useState("");

  function submit() {
    setPilotToken(value.trim() || null);
    setValue("");
    onUnlocked();
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-white px-5 py-4 text-sm text-stone-700 shadow-xs">
      <p className="font-display text-lg font-medium text-stone-900">Pilot access required</p>
      <p className="mt-1">Enter the shared pilot token to view deal documents.</p>
      <div className="mt-3 flex gap-2">
        <input
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Pilot token"
          aria-label="Pilot token"
          className="h-9 min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-2.5 text-sm text-stone-900 transition-colors duration-150 ease-app placeholder:text-stone-500 focus:border-teal-700 focus:outline-none"
        />
        <Button size="sm" onClick={submit} disabled={!value.trim()}>
          Unlock
        </Button>
      </div>
    </div>
  );
}
