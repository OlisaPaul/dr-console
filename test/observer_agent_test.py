"""Offline tests; do not contact MariaDB/systemd/SSH."""
import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("observer", pathlib.Path(__file__).parents[1] / "deploy" / "convox-console-status.py")
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)

class ObserverTests(unittest.TestCase):
    def test_fixed_queries_and_no_database_data_permissions(self):
        calls = []
        def fake_run(args):
            calls.append(args)
            if args[-1].startswith("SELECT"):
                return "hostname\tserverId\treadOnly\tlogBin\tlogSlaveUpdates\tgtidSlave\tgtidBinlog\tgtidCurrent\teventScheduler\nconvox\t8111\t0\t1\t0\t\t0-8111-10\t0-8111-10\tOFF\n"
            return ""
        with patch.object(observer, "run", fake_run):
            db = observer.database()
            self.assertEqual(db["serverId"], 8111)
            self.assertFalse(db["readOnly"])
            self.assertEqual(observer.replicas(), [])
        self.assertEqual(calls[1][-1], "SHOW ALL SLAVES STATUS")
        self.assertIn("--no-defaults", calls[0])
        self.assertIn("--user=convoxstatus", calls[0])

    def test_replication_null_lag_and_errors_are_sanitized(self):
        data = "Slave_IO_Running\tSlave_SQL_Running\tSeconds_Behind_Master\tMaster_Host\tLast_IO_Error\tLast_SQL_Error\nYes\tNo\tNULL\t10.81.0.11\t\tSensitive SQL or phone number\n"
        with patch.object(observer, "run", return_value=data):
            result = observer.replicas()[0]
        self.assertIsNone(result["lag"])
        self.assertTrue(result["sqlError"])
        self.assertNotIn("Sensitive", str(result))

    def test_database_failure_is_not_fake_healthy(self):
        with patch.object(observer, "database", side_effect=RuntimeError("denied")), patch.object(observer, "services", return_value=[]), patch.object(observer.subprocess, "run", side_effect=RuntimeError("no processes")):
            result = observer.collect()
        self.assertIsNone(result["db"])
        self.assertEqual(result["replicas"], [])

    def test_invalid_tsv_is_rejected(self):
        with self.assertRaises(ValueError):
            observer.rows("one\ttwo\nonly-one\n")

    def test_missing_unit_does_not_hide_later_mariadb_and_lsyncd_units(self):
        calls = []
        def probe(args, **kwargs):
            from types import SimpleNamespace
            calls.append(args)
            missing = args[2] == 'crond.service'
            return SimpleNamespace(returncode=1 if missing else 0, stdout='LoadState=' + ('not-found' if missing else 'loaded') + '\nActiveState=inactive\nUnitFileState=disabled\n')
        with patch.object(observer, 'run', return_value=''), patch.object(observer.subprocess, 'run', side_effect=probe):
            units = observer.services()
        self.assertEqual({u['name'] for u in units}, {'mariadb.service', 'crond.service', 'lsyncd.service'})
        self.assertEqual(len(calls), 3)

if __name__ == "__main__":
    unittest.main()
