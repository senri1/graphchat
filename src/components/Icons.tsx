import React from 'react';

type IconProps = React.SVGProps<SVGSVGElement>;

export const Icons = {
  gear: (props: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" {...props}>
      <path
        fillRule="evenodd"
        d="M11.983 1.775a1 1 0 00-1.966 0l-.138.98a6.989 6.989 0 00-1.508.623l-.84-.52a1 1 0 00-1.366.366l-.983 1.703a1 1 0 00.366 1.366l.84.52c-.155.49-.27 1-.34 1.526l-.983.142a1 1 0 00-.862 1.146l.3 1.957a1 1 0 001.146.862l.983-.142c.206.49.461.954.761 1.386l-.6.788a1 1 0 00.158 1.353l1.5 1.299a1 1 0 001.353-.158l.6-.788c.456.21.935.377 1.433.497l.139.98a1 1 0 001.966 0l.139-.98c.498-.12.977-.287 1.432-.497l.6.788a1 1 0 001.353.158l1.5-1.299a1 1 0 00.158-1.353l-.6-.788c.3-.432.555-.896.76-1.386l.984.142a1 1 0 001.146-.862l.3-1.957a1 1 0 00-.862-1.146l-.984-.142a6.974 6.974 0 00-.339-1.526l.84-.52a1 1 0 00.366-1.366l-.983-1.703a1 1 0 00-1.366-.366l-.84.52a6.989 6.989 0 00-1.508-.623l-.138-.98zM10 7.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5z"
        clipRule="evenodd"
      />
    </svg>
  ),
  pen: (props: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      {...props}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.862 3.487a1.875 1.875 0 112.651 2.651L7.5 18.151 3 21l2.849-4.5 11.013-11.013z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 6l-1.5-1.5" />
    </svg>
  ),
  inkBox: (props: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      {...props}
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.75" ry="2.75" />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M16.5 7.5l1.5 1.5M15.8 8.2L9.25 14.75 8 18l3.25-1.25 6.55-6.55a1.06 1.06 0 000-1.5l-.55-.55a1.06 1.06 0 00-1.5 0z"
      />
    </svg>
  ),
};

