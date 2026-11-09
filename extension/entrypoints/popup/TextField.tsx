interface TextFieldProps {
  label: string;
  value: string;
  placeholder: string;
  onChange?: (value: string) => void; // 없으면 읽기 전용
}

export function TextField({ label, value, placeholder, onChange }: TextFieldProps) {
  return (
    <label className="block space-y-1">
      <span className="font-medium">{label}</span>
      <input
        readOnly={!onChange}
        value={value}
        onChange={onChange && ((e) => onChange(e.target.value))}
        placeholder={placeholder}
        className="w-full rounded-md border px-2.5 py-1.5 outline-none focus:border-tag-decision"
      />
    </label>
  );
}
