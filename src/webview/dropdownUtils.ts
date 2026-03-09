/**
 * Shared dropdown navigation utilities.
 * Used by TabUIManager and TabTitleManager.
 */

export function hideAllDropdowns(): void {
  const dropdowns = document.querySelectorAll(".tab-dropdown");
  dropdowns.forEach((dropdown) => {
    dropdown.classList.remove("show");
  });
}

export function focusNextDropdownItem(container: Element | null, currentItem: HTMLElement): void {
  if (!container) return;
  const items = container.querySelectorAll<HTMLElement>(".tab-dropdown-item:not(.disabled)");
  const currentIndex = Array.from(items).indexOf(currentItem);
  const nextIndex = (currentIndex + 1) % items.length;
  items[nextIndex]?.focus();
}

export function focusPrevDropdownItem(container: Element | null, currentItem: HTMLElement): void {
  if (!container) return;
  const items = container.querySelectorAll<HTMLElement>(".tab-dropdown-item:not(.disabled)");
  const currentIndex = Array.from(items).indexOf(currentItem);
  const prevIndex = currentIndex === 0 ? items.length - 1 : currentIndex - 1;
  items[prevIndex]?.focus();
}
