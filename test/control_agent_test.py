"""Pure/mocked agent tests: never execute systemctl, mysql, SSH or file copies."""
import importlib.util
import pathlib
import unittest
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('agent', pathlib.Path(__file__).parents[1] / 'deploy' / 'convox-console-control.py')
# fcntl does not exist on Windows; provide a test-only import stub.
import sys
from types import SimpleNamespace
if sys.platform == 'win32':
    sys.modules.setdefault('fcntl', SimpleNamespace())
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.cfg = {'host': 'production', 'clusterSecret': 'ab' * 32}
        self.request = {'version': 1, 'host': 'production', 'source': 'production', 'target': 'dr',
                        'operation': 'fence', 'jobId': '12345678-1234-1234-1234-123456789abc'}

    def test_unknown_commands_and_arbitrary_host_are_rejected(self):
        for changes in [{'operation': 'shell'}, {'host': 'other'}, {'target': 'production'}, {'jobId': '../escape'}]:
            with self.assertRaises(agent.Refusal):
                agent.valid_request({**self.request, **changes}, 'production')

    def test_receipts_require_matching_job_kind_source_and_signature(self):
        receipt = agent.sign_receipt(self.cfg, self.request, 'fence', gtid='0-8111-100')
        agent.verify_receipt(self.cfg, self.request, receipt, 'fence')
        for field, value in [('gtid', '0-8111-99'), ('jobId', 'different'), ('host', 'dr')]:
            changed = {'payload': {**receipt['payload'], field: value}, 'signature': receipt['signature']}
            with self.assertRaises(agent.Refusal):
                agent.verify_receipt(self.cfg, self.request, changed, 'fence')
        with self.assertRaises(agent.Refusal):
            agent.verify_receipt(self.cfg, self.request, receipt, 'files')

    def test_stale_fencing_evidence_and_future_clock_are_rejected(self):
        with patch.object(agent.time, 'time', return_value=100):
            receipt = agent.sign_receipt(self.cfg, self.request, 'fence', gtid='0-8111-100')
        for now in [99, 131]:
            with patch.object(agent.time, 'time', return_value=now), self.assertRaises(agent.Refusal):
                agent.verify_receipt(self.cfg, self.request, receipt, 'fence')

    def test_zombies_are_not_live_writers_but_web_and_vendor_processes_are(self):
        processes = [{'pid': 1, 'state': 'Z', 'name': 'asterisk'}, {'pid': 2, 'state': 'S', 'name': 'safe_asterisk'},
                     {'pid': 3, 'state': 'S', 'name': 'nginx'}, {'pid': 4, 'state': 'S', 'name': 'python3', 'vendor': True},
                     {'pid': 5, 'state': 'S', 'name': 'sshd'}]
        with patch.object(agent, 'processes', return_value=processes):
            self.assertEqual([p['pid'] for p in agent.writers()], [2, 3, 4])

    def test_unfenced_source_never_gets_a_fence_receipt(self):
        state = {'boundary': '0-8111-100', 'filesVerified': '0-8111-100'}
        with patch.object(agent, 'database_fenced', return_value=False), patch.object(agent, 'application_fenced', return_value=False), patch.object(agent, 'command') as cmd:
            with self.assertRaises(agent.Refusal):
                agent.fence(self.cfg, self.request, state)
            cmd.assert_not_called()

    def test_promotion_without_backup_or_target_application_fence_is_refused(self):
        cfg = {**self.cfg, 'host': 'dr'}
        request = {**self.request, 'host': 'dr', 'operation': 'promote'}
        with patch.object(agent, 'sql') as sql:
            with self.assertRaises(agent.Refusal):
                agent.promote(cfg, request, {})
            sql.assert_not_called()

    def test_promotion_requires_three_agreeing_signed_receipts(self):
        cfg = {**self.cfg, 'host': 'dr'}
        request = {**self.request, 'host': 'dr', 'operation': 'promote'}
        for kind in ['boundary', 'files', 'fence']:
            request[kind] = agent.sign_receipt(self.cfg, self.request, kind, gtid='0-8111-' + ('99' if kind == 'files' else '100'))
        with patch.object(agent, 'application_fenced', return_value=True), patch.object(agent, 'sql') as sql:
            with self.assertRaises(agent.Refusal):
                agent.promote(cfg, request, {'backup': 'fixture', 'steps': {'backup': 'complete'}, 'caughtUp': '0-8111-100'})
            sql.assert_not_called()

    def test_effective_persistent_role_honors_last_option_and_skip_override(self):
        self.assertTrue(agent.effective_read_only('--read_only=OFF\n--read-only=ON\n'))
        self.assertFalse(agent.effective_read_only('--read-only=ON\n--skip-read-only\n'))
        self.assertIsNone(agent.effective_read_only('--some-other-option=1\n'))

    def test_no_reseed_or_arbitrary_sql_operation_is_available(self):
        for operation in ['seed', 'rejoin', 'sql', 'reset-master', 'route']:
            with self.assertRaises(agent.Refusal):
                agent.valid_request({**self.request, 'operation': operation}, 'production')

    def test_wrapper_requires_foreground_support_and_preserves_private_environment(self):
        with patch.object(agent.pathlib.Path, 'is_file', return_value=True), \
             patch.object(agent.os, 'access', return_value=True), \
             patch.object(agent.pathlib.Path, 'read_text', return_value='if test -n "$ASTSAFE_FOREGROUND"; then run_asterisk; fi'):
            env = agent.wrapper_environment()
            self.assertEqual(env['ASTSAFE_FOREGROUND'], '1')
            self.assertEqual(env['HOME'], '/root')
            self.assertNotIn('ASTSAFE_FOREGROUND', agent.ENV)
        with patch.object(agent.pathlib.Path, 'is_file', return_value=True), \
             patch.object(agent.os, 'access', return_value=True), \
             patch.object(agent.pathlib.Path, 'read_text', return_value='run_asterisk &'), self.assertRaises(agent.Refusal):
            agent.wrapper_environment()

    def test_expired_source_read_lock_blocks_file_transfer_before_any_command(self):
        with patch.object(agent, 'application_fenced', return_value=True), patch.object(agent, 'lock_alive', return_value=False), patch.object(agent, 'command') as cmd:
            with self.assertRaises(agent.Refusal):
                agent.files(self.cfg, self.request, {'boundary': '0-8111-100'})
            cmd.assert_not_called()

    def test_partial_backup_cannot_authorize_source_shutdown_or_target_promotion(self):
        state = {'backup': 'partially-written-fixture', 'steps': {'backup': 'failed'}}
        with patch.object(agent, 'sql') as sql, patch.object(agent, 'command') as cmd:
            with self.assertRaises(agent.Refusal):
                agent.quiesce(self.cfg, self.request, state)
            with self.assertRaises(agent.Refusal):
                agent.promote({**self.cfg, 'host': 'dr'}, {**self.request, 'host': 'dr'}, state)
            sql.assert_not_called(); cmd.assert_not_called()

    def test_reserved_job_requires_its_own_preflight_and_cannot_replay_steps(self):
        cfg = {**self.cfg, 'adminReviewedStartup': True}
        with tempfile.TemporaryDirectory() as directory, patch.object(agent, 'ROOT', pathlib.Path(directory)):
            reserve = {**self.request, 'operation': 'reserve'}
            agent.dispatch(cfg, reserve)
            with self.assertRaises(agent.Refusal):
                agent.dispatch(cfg, {**self.request, 'operation': 'backup'})
            with patch.object(agent, 'preflight', return_value={'ok': True, 'ready': True}):
                agent.dispatch(cfg, {**self.request, 'operation': 'preflight'})
            with patch.object(agent, 'backup', return_value={'ok': True}) as backup:
                agent.dispatch(cfg, {**self.request, 'operation': 'backup'})
                with self.assertRaises(agent.Refusal):
                    agent.dispatch(cfg, {**self.request, 'operation': 'backup'})
                self.assertEqual(backup.call_count, 1)
            with self.assertRaises(agent.Refusal):
                agent.dispatch(cfg, {**reserve, 'jobId': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'})

    def test_valid_promotion_preserves_binlogs_and_never_changes_local_tables(self):
        cfg = {**self.cfg, 'host': 'dr'}
        request = {**self.request, 'host': 'dr', 'operation': 'promote'}
        for kind in ['boundary', 'files', 'fence']:
            request[kind] = agent.sign_receipt(self.cfg, self.request, kind, gtid='0-8111-100')
        state = {'backup': 'fixture', 'steps': {'backup': 'complete'}, 'caughtUp': '0-8111-100'}
        with tempfile.TemporaryDirectory() as directory, patch.object(agent, 'ROOT', pathlib.Path(directory)), \
             patch.object(agent, 'application_fenced', return_value=True), \
             patch.object(agent, 'db', side_effect=[{'readOnly': True}, {'readOnly': False}]), \
             patch.object(agent, 'persist_role') as persist, patch.object(agent, 'sql', return_value='') as sql:
            result = agent.promote(cfg, request, state)
            self.assertTrue(result['ok']); persist.assert_called_once_with(False)
            self.assertTrue(state['promoted'])
            statements = ' '.join(c.args[0] for c in sql.call_args_list)
            for forbidden in ['RESET MASTER', 'DROP', 'UPDATE', 'DELETE']:
                self.assertNotIn(forbidden, statements)
            self.assertTrue((pathlib.Path(directory) / 'primary').exists())


if __name__ == '__main__':
    unittest.main()
