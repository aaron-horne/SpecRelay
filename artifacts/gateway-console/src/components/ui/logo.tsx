import { SVGProps } from "react";

export function LogoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 42 40" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <defs>
        <filter id="relay-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <g stroke="#32C5FF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 5h22c7 0 10 4 10 10s-5 5-16 5" />
        <path d="M21 20h-7c-6 0-9 3-9 7s4 8 10 8h22" />
      </g>
      <g filter="url(#relay-glow)">
        <circle cx="5" cy="5" r="4.2" fill="#F5F7FA" stroke="#32C5FF" strokeWidth="2.6" />
        <circle cx="37" cy="35" r="4.2" fill="#F5F7FA" stroke="#32C5FF" strokeWidth="2.6" />
      </g>
      <path d="m15 14 6-2.6 6 2.6v5.4c0 5.1-6 8.2-6 8.2s-6-3.1-6-8.2z" fill="#0B0D10" stroke="#32C5FF" strokeWidth="2" strokeLinejoin="round" />
      <path d="m18.1 19.3 2 2 4-4.2" stroke="#32C5FF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className = "h-8" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-3 ${className}`}>
      <LogoIcon className="h-full w-auto" />
      <span className="font-sans text-lg tracking-[-0.04em] text-current">
        <span className="font-normal">Spec</span><span className="font-bold">Relay</span>
      </span>
    </span>
  );
}
