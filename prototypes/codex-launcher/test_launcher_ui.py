"""Windows native widget checks; no installed plugin or live credentials needed."""

import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import urlencode

SPEC = importlib.util.spec_from_file_location("launcher_ui_under_test", Path(__file__).with_name("launcher.py"))
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


@unittest.skipUnless(os.name == "nt", "Requires the Windows native Tk desktop")
class WizardTests(unittest.TestCase):
    def setUp(self):
        link = "gatherthread-connect://connect?" + urlencode({
            "v": "2", "origin": launcher.TEST_SERVER_ORIGIN, "project": "project-ui-test",
            "model": "gpt-6-luna", "context_window_tokens": "65536", "visible_history_sync": "first-connect",
            "email": "test@example.com", "authorization_id": "11111111-2222-4333-8444-555555555555",
        })
        self.app = launcher.Launcher(link)
        self.app.update()
        self.addCleanup(self.close_app)

    def close_app(self):
        for callback in self.app.tk.call("after", "info"):
            self.app.after_cancel(callback)
        self.app.destroy()

    def test_steps_validate_password_without_authorizing_until_connect(self):
        with patch.object(launcher, "claim_email_authorization") as claim:
            self.app._next_page()
            self.assertEqual(self.app.page, 1)
            self.app._next_page()
            self.assertEqual(self.app.page, 1)
            self.app.password.set("fixture-password")
            self.app._next_page()
            self.assertEqual(self.app.page, 2)
            claim.assert_not_called()

    def test_default_root_remains_visible_and_reset_preserves_default_flag(self):
        self.app._show_page(2)
        self.app.update()
        self.assertEqual(self.app.workspace_display.get(), str(Path.home() / "GatherThread Projects"))
        self.app.workspace.set("")
        self.assertIsNone(launcher.selected_workspace(self.app.workspace.get()))
        self.assertFalse(Path(self.app.actual_workspace.get()).is_absolute())

    def test_browse_default_opens_existing_parent_without_creating_directories(self):
        with patch.object(launcher.os, "startfile", create=True) as open_folder, \
                patch.object(Path, "mkdir") as mkdir:
            self.app._browse_workspace()
        self.assertTrue(Path(open_folder.call_args.args[0]).is_dir())
        mkdir.assert_not_called()

    def test_change_path_replaces_display_and_is_used_by_connector(self):
        self.app._show_page(2)
        custom = str(Path(__file__).parent.resolve())
        with patch.object(launcher.filedialog, "askdirectory", return_value=custom) as chooser:
            self.app.change_workspace_button.invoke()
        chooser.assert_called_once()
        self.assertEqual(self.app.workspace_display.get(), custom)
        self.assertEqual(self.app.workspace.get(), custom)
        args = launcher.connector_args(Path("node.exe"), Path("connector.js"), launcher.TEST_SERVER_ORIGIN,
                                       "project-ui-test", "gpt-6-luna", 65536, "first-connect", "codex.exe",
                                       launcher.selected_workspace(self.app.workspace.get()))
        self.assertNotIn("--create-workspace", args)
        self.assertEqual(args[args.index("--workspace") + 1], custom)
        with patch.object(launcher.filedialog, "askdirectory", return_value=""):
            self.app.change_workspace_button.invoke()
        self.assertEqual(self.app.workspace_display.get(), custom)
        self.app.workspace.set("")
        self.assertEqual(self.app.workspace_display.get(), self.app.default_root)

    def test_fourth_page_has_its_own_navigation_and_keeps_status_out_of_directory_page(self):
        self.assertEqual(len(self.app.step_labels), 4)
        self.assertIn("连接与同步状态", self.app.step_labels[3]["text"])
        self.app._navigate_page(2)
        self.app.events.put(("log", "Connected session: Test [multi]"))
        self.app._poll()
        self.app.update()
        self.assertEqual(self.app.page, 2)
        self.assertFalse(self.app.log.winfo_ismapped())
        self.app._navigate_page(3)
        self.app.update()
        self.assertTrue(self.app.log.winfo_ismapped())
        self.assertIn("会话连接成功", self.app.session_state.get())

    def test_legacy_and_missing_handoffs_keep_their_separate_forms(self):
        values = {"v": "1", "origin": launcher.SERVER_ORIGIN, "project": "project-legacy",
                  "model": "gpt-6-luna", "context_window_tokens": "65536", "visible_history_sync": "never"}
        self.app._apply_link("gatherthread-connect://connect?" + urlencode(values))
        self.app._show_page(1)
        self.app.update()
        self.assertTrue(self.app.legacy_form.winfo_ismapped())
        self.assertFalse(self.app.email_form.winfo_ismapped())
        self.app._next_page()
        self.assertEqual(self.app.page, 1)
        self.app.token.set("gtd_" + "x" * 43)
        self.app._next_page()
        self.assertEqual(self.app.page, 2)
        self.app._apply_link("gatherthread-connect://invalid")
        self.app._show_page(1)
        self.app.update()
        self.assertTrue(self.app.web_form.winfo_ismapped())
        self.assertEqual(str(self.app.connect_button["state"]), "disabled")

    def test_high_contrast_uses_system_colors_without_changing_os_settings(self):
        self.app.high_contrast = True
        self.app._apply_high_contrast(launcher.ttk.Style(self.app))
        self.app._show_page(1)
        self.assertEqual(self.app.step_labels[1]["background"], "SystemHighlight")

    def test_invalid_workspace_does_not_consume_authorization(self):
        self.app.password.set("fixture-password")
        self.app.workspace.set("relative/invalid")
        with patch.object(self.app, "_paths", return_value=(Path("node.exe"), "codex.exe")), \
                patch.object(launcher, "bundled_connector", return_value=Path(__file__)), \
                patch.object(launcher.messagebox, "showerror") as error, \
                patch.object(launcher, "claim_email_authorization") as claim:
            self.app._connect()
        error.assert_called_once()
        claim.assert_not_called()
        self.assertFalse(self.app.authorization_used)
        self.assertEqual(self.app.password.get(), "")

    def test_status_requires_known_connector_output_and_handles_exit(self):
        self.app.events.put(("log", "untrusted text: Connected session: fake"))
        self.app._poll()
        self.assertIn("尚未连接", self.app.connection_state.get())
        for line in ("Workspace: F:\\Projects\\Example", "Connected session: Test [multi]"):
            self.app.events.put(("log", line))
        self.app._poll()
        self.assertEqual(self.app.actual_workspace.get(), "F:\\Projects\\Example")
        self.assertIn("会话连接成功", self.app.session_state.get())
        self.app.events.put(("status", "连接器已退出，代码 1。可检查日志后重试。"))
        self.app._poll()
        self.assertIn("连接已结束", self.app.session_state.get())

    def test_sync_retry_stays_visible_until_all_scopes_recover(self):
        for line in ("gatherthread-codex (project refresh): offline; retrying",
                     "gatherthread-codex (session-a): offline; retrying",
                     "gatherthread-codex (session-a): recovered"):
            self.app.events.put(("log", line))
        self.app._poll()
        self.assertIn("正在重试", self.app.session_state.get())
        self.app.events.put(("log", "gatherthread-codex (project refresh): recovered"))
        self.app._poll()
        self.assertIn("已恢复", self.app.session_state.get())

    def test_small_window_keeps_navigation_visible_and_content_scrollable(self):
        self.app.geometry("940x740")
        for page in range(4):
            self.app._show_page(page)
            self.app.update()
            self.assertTrue(self.app.back_button.winfo_ismapped())
            self.assertLess(self.app.back_button.winfo_rooty() + self.app.back_button.winfo_height(), self.app.winfo_rooty() + self.app.winfo_height())
        self.app._show_page(2)
        self.app.update()
        self.assertLess(self.app.page_canvas.yview()[1], 1)

    def test_claude_handoff_preserves_exact_harness_and_file_sync_consent(self):
        values = {"v": "3", "origin": launcher.TEST_SERVER_ORIGIN, "project": "project-ui-test",
                  "model": "claude-sonnet-4-6", "context_window_tokens": "65536",
                  "visible_history_sync": "never", "email": "test@example.com",
                  "authorization_id": "11111111-2222-4333-8444-555555555555", "harness": "claude-code"}
        with patch.object(self.app, "_discover_claude"):
            self.app._apply_link("gatherthread-connect://connect?" + urlencode(values))
        self.app._show_page(1)
        self.app.update()
        self.assertEqual(self.app.harness, "claude-code")
        self.assertIn("Claude Code", self.app.cli_label.get())
        self.assertTrue(self.app.code_sync_row.winfo_ismapped())
        self.assertFalse(self.app.code_sync.get())
        self.assertTrue(all(not column.winfo_ismapped() for column in self.app.codex_only_settings))
        with patch.object(launcher, "claim_email_authorization") as claim:
            self.app.password.set("fixture-password")
            self.app._next_page()
        self.assertEqual(self.app.page, 2)
        claim.assert_not_called()

    def test_stopping_connector_cannot_restore_connected_status_cards(self):
        process = MagicMock()
        process.poll.return_value = None
        self.app.connector = self.app.stopping_connector = process
        self.app.status.set("正在断开连接 / Disconnecting")
        before = self.app.connection_state.get()
        self.app.events.put(("connector_log", (process, "GatherThread connector ready.")))
        self.app._poll()
        self.assertEqual(self.app.connection_state.get(), before)
        self.app.events.put(("connector_exit", (process, 0)))
        self.app._poll()
        self.assertIsNone(self.app.connector)
        self.assertIn("连接已结束", self.app.session_state.get())

    def test_busy_navigation_and_install_are_disabled(self):
        self.app._set_busy(True)
        self.assertEqual(str(self.app.next_button["state"]), "disabled")
        self.assertEqual(str(self.app.install_button["state"]), "disabled")
        self.app._next_page()
        self.assertEqual(self.app.page, 0)
        self.app._navigate_page(2)
        self.assertEqual(self.app.page, 0)
        self.app._navigate_page(3)
        self.assertEqual(self.app.page, 3)
        self.app._set_busy(False)


if __name__ == "__main__":
    unittest.main()
