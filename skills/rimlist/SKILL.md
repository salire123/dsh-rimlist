---
name: rimlist
description: Manage the user's RimWorld mods through the dsh-rimlist plugin — inspect the load order, sort it, diagnose missing dependencies / version mismatches / incompatibilities, read Player.log errors, classify and tag mods, save/import/share mod lists, back up or roll back mod versions, and launch the game.
whenToUse: The user talks about RimWorld (环世界), its mods, load order (Mod 排序), ModsConfig.xml, red errors / Player.log / 游戏报错, mod conflicts, mod lists, Steam Workshop mods, or wants to start / quick-test the game. Use the rimlist_* tools rather than editing game files by hand.
disable-model-invocation: true
metadata:
  version: "1"
---

# Managing RimWorld mods with rimlist

All work goes through the `rimlist_*` tools. Do not edit `ModsConfig.xml` or mod folders by hand — the tools back files up before writing.

## Start by looking

1. `rimlist_status` — game version, paths, installed/active counts, rule databases, diagnostics summary.
2. `rimlist_get_all_notes` — the user's own notes about mods (known conflicts, preferences). Respect them.
3. `rimlist_active` (load order), `rimlist_mod` (one mod), `rimlist_search` (by name / type / tag) for details.

## Common tasks

- **Game errors / crashes**: `rimlist_game_log` (level=error first, then warning). Group repeated errors, name the mod responsible, explain the cause and a fix (reorder, other version, remove, ignore). Use `rimlist_mod_updates` when the game broke after mod updates, and `rimlist_mod_backup` to roll a mod back.
- **Load-order problems**: `rimlist_diagnose`, then `rimlist_explain` for one mod. Preview with `rimlist_sort` (save=false), show the change, and only save (save=true) after the user agrees. If the community rules are wrong, use `rimlist_rule` or `rimlist_pin_order`.
- **Enable / disable / move mods**: `rimlist_set_active`. Run `rimlist_diagnose` afterwards.
- **New or removed mods on disk**: `rimlist_rescan`.
- **Mod lists**: `rimlist_lists` (save / apply / compare / export / install_missing), `rimlist_import` for lists from other players, `rimlist_git` for git-hosted mods.
- **Save files**: `rimlist_saves` — action=list (saves with game version + mod count), action=show (a save's mods, what is not installed, diff vs the current load order), action=import (store a save's mod list as a named list, then `rimlist_lists` apply / install_missing). Use it when the user wants "the mods this save was played with".
- **Tags / categories**: `rimlist_classify`, `rimlist_classify_all`, `rimlist_tag_review` + `rimlist_set_tags` to fix tags; never overwrite source=user tags unless asked.
- **Notes**: `rimlist_get_note` / `rimlist_set_note` to read or record what the user wants remembered about a mod.
- **Launching**: `rimlist_launch` (quicktest=true for a fast load check), `rimlist_game` to check or stop the running game, then `rimlist_game_log` to verify.
- **Rule databases**: `rimlist_databases`.
- **Plugin trouble**: `rimlist_debug_log`.

## Rules

- Writes (`rimlist_sort save=true`, `rimlist_set_active`, `rimlist_lists apply`, `rimlist_mod_backup restore`, `rimlist_reset_tags`, stopping the game) change the user's setup: describe what will change and confirm first unless the user already asked for exactly that.
- Stopping the game loses unsaved progress — say so before `rimlist_game action=stop`.
- After changing the load order, re-run `rimlist_diagnose` and report remaining problems honestly.
- Reply in the user's language; keep packageIds as written.
