import { useEffect, useState } from "react";
import { ChevronDownIcon } from "../../ui/icons";

/** A checkbox drawn as a switch, so it keeps native checkbox keyboard and form behaviour. */
export function SettingsSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <input
      aria-label={label}
      checked={checked}
      className="settings-switch"
      disabled={disabled}
      role="switch"
      type="checkbox"
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

export interface SettingsSegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

/** Two or three mutually exclusive options, shown inline like Codex's "Bottom | Right". */
export function SettingsSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly SettingsSegmentedOption<T>[];
  readonly value: T | undefined;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div aria-label={label} className="settings-segmented" role="group">
      {options.map((option) => (
        <button
          aria-pressed={option.value === value}
          className="settings-segmented__option"
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly SettingsSegmentedOption<T>[];
  readonly value: T | undefined;
  readonly onChange: (value: T) => void;
}) {
  // Saving is a round trip, and a select bound only to the saved value snaps back to the old
  // choice until it lands, which reads as "it won't change". Show the pick until the saved value
  // moves, or for 5 s if the save never lands (then the real value shows again).
  const [pick, setPick] = useState<{ readonly from: T | undefined; readonly to: T }>();
  useEffect(() => {
    if (!pick) return;
    const timer = window.setTimeout(() => setPick(undefined), 5_000);
    return () => window.clearTimeout(timer);
  }, [pick]);
  const shown = pick && pick.from === value ? pick.to : value;
  // Without a matching option Chromium shows the first one as chosen, and choosing it
  // fires no change, so an unset value gets an explicit placeholder instead.
  const hasValue = options.some((option) => option.value === shown);
  return (
    <span className="settings-select-control">
      <select
        aria-label={label}
        value={hasValue ? shown : ""}
        onChange={(event) => {
          const selected = options.find((option) => option.value === event.currentTarget.value);
          if (!selected) return;
          setPick({ from: value, to: selected.value });
          onChange(selected.value);
        }}
      >
        {hasValue ? null : (
          <option disabled value="">
            Choose…
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon />
    </span>
  );
}
