import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders icon, message, and detail", () => {
    render(<EmptyState icon="⚪" message="No cards" detail="Come back later" />);
    expect(screen.getByText("No cards")).toBeTruthy();
    expect(screen.getByText("Come back later")).toBeTruthy();
    expect(screen.getByText("⚪")).toBeTruthy();
  });

  it("shows progress bar when requested", () => {
    render(<EmptyState icon="⚙️" message="Waiting" showProgress />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });
});
