import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "inStyle Salon",
  description: "Operations and analytics for inStyle Salon, Goa, Camarines Sur",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
