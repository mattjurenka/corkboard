// The treats an avatar can be fed (dragged to her mouth), drawn.

export type Treat = "cheesecake" | "cookie" | "muffin";
export const TREATS: Treat[] = ["cheesecake", "cookie", "muffin"];

export function TreatIcon({ treat, className }: { treat: Treat; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className}>
      {treat === "cheesecake" && (
        <>
          <path d="M2 9 L18 5 L18 16 L2 16 Z" fill="#f4e4b5" />
          <path d="M2 9 L18 5 L18 7.5 L2 11 Z" fill="#c8323f" />
          <rect x="2" y="15.5" width="16" height="2.5" fill="#a9682f" />
          <circle cx="13" cy="4.6" r="2" fill="#e0384a" />
          <path d="M12.4 2.8 L13 1.8 L13.6 2.8" stroke="#3f8f3a" strokeWidth="0.9" fill="none" />
        </>
      )}
      {treat === "cookie" && (
        <>
          <circle cx="10" cy="10" r="8" fill="#d39a52" />
          <circle cx="10" cy="10" r="8" fill="none" stroke="#a96c2e" strokeWidth="0.8" />
          {[[7, 6.5], [12.5, 7], [6, 11.5], [10.5, 11], [13.5, 13.5], [8.5, 15]].map(([x, y]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r="1.1" fill="#4a2a17" />
          ))}
        </>
      )}
      {treat === "muffin" && (
        <>
          <path d="M4.5 11 L15.5 11 L14 18.5 L6 18.5 Z" fill="#e7d3b0" />
          {[7.5, 10, 12.5].map((x) => (
            <path key={x} d={`M${x} 11 L${x + (x - 10) * 0.15} 18.5`} stroke="#c5aa7c" strokeWidth="0.7" />
          ))}
          <path d="M2.5 11.5 Q2 3 10 3 Q18 3 17.5 11.5 Z" fill="#9a6232" />
          {[[7, 6.5], [11.5, 5.5], [13.5, 9], [8.5, 9.5]].map(([x, y]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r="1" fill="#3d3f86" />
          ))}
        </>
      )}
    </svg>
  );
}
