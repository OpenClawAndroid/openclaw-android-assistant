import { html } from "lit";
import { COMMAND_PALETTE_DIALOG_STYLE } from "../components/command-palette-contract.ts";
import { t } from "../i18n/index.ts";

export function renderCommandPaletteLoading(onClose: () => void) {
  const label = t("palette.placeholder");
  return html`<openclaw-modal-dialog
    class="cmd-palette-overlay palette"
    label=${label}
    style=${COMMAND_PALETTE_DIALOG_STYLE}
    @modal-cancel=${onClose}
  >
    <div class="cmd-palette" role="status" aria-label=${t("common.loading")}>
      <div class="cmd-palette__searchbar">
        <input class="cmd-palette__input" disabled placeholder=${label} />
      </div>
      <div class="cmd-palette__empty">${t("common.loading")}</div>
    </div>
  </openclaw-modal-dialog>`;
}
