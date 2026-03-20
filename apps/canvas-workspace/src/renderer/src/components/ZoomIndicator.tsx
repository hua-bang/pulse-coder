interface Props {
  scale: number;
  onReset: () => void;
}

export const ZoomIndicator = ({ scale, onReset }: Props) => {
  const pct = Math.round(scale * 100);
  return (
    <button className="zoom-indicator" onClick={onReset} title="Reset to 100%">
      {pct}%
    </button>
  );
};
