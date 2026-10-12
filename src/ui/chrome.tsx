import React from 'react';

/** Shared compact instrument controls — one visual language across all toys. */

export function Bar({ children }: { children: React.ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function Group({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="grp">
      {label && <label>{label}</label>}
      {children}
    </div>
  );
}

export function Pill({
  active,
  children,
  onClick,
  title,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button type="button" aria-pressed={!!active} className={`pill${active ? ' on' : ''}` onClick={onClick} title={title}>
      {children}
    </button>
  );
}

export function Btn({
  children,
  onClick,
  warn,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  warn?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button type="button" aria-pressed={active === undefined ? undefined : active} className={`btn${warn ? ' warn' : ''}${active ? ' on' : ''}` onClick={onClick} title={title}>
      {children}
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  width = 104,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  width?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider">
      <span className="slider-label">{label}</span>
      <input
        aria-label={label}
        type="range"
        style={{ width }}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <span className="val">{format ? format(value) : value.toFixed(2)}</span>
    </label>
  );
}

export function Dots({
  colors,
  index,
  onPick,
}: {
  colors: string[];
  index: number;
  onPick: (i: number) => void;
}) {
  return (
    <span className="dots">
      {colors.map((c, i) => (
        <button
          type="button"
          key={c + i}
          className={`dot${i === index ? ' on' : ''}`}
          style={{ background: c }}
          onClick={() => onPick(i)}
          aria-label={`color ${c}`}
        />
      ))}
    </span>
  );
}

export function Stat({ children }: { children: React.ReactNode }) {
  return <span className="stat">{children}</span>;
}

export function Spacer() {
  return <span className="spacer" />;
}
