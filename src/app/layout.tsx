import type { ReactNode } from "react";
import "./studio-v2.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="ru"><body style={{ margin: 0 }}>{children}</body></html>;
}
