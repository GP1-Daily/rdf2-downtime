const assert = require('node:assert/strict');
const test = require('node:test');

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL storage supports range queries and system health records', {
  skip: !testDatabaseUrl,
}, async () => {
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.MIGRATION_DATABASE_URL = testDatabaseUrl;
  process.env.DATABASE_SSL = 'false';
  process.env.NODE_ENV = 'test';
  const store = require('../pg-store');

  try {
    await store.deleteRowsByReportDate('Downtime', 'EntryDate', '2099-12-27');
    await store.deleteRowsByReportDate('Downtime', 'EntryDate', '2099-12-28');
    const row = await store.appendRow('Downtime', {
      EntryDate: '2099-12-27',
      StartTime: '08:00',
      EndTime: '08:15',
      Reason: 'Storage integration test',
      Note: '',
    });
    await store.appendRow('Downtime', {
      EntryDate: '2099-12-28',
      StartTime: '09:00',
      EndTime: '09:05',
      Reason: 'Outside range',
      Note: '',
    });

    const selected = await store.readSheetRange('Downtime', 'EntryDate', '2099-12-27', '2099-12-27');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].Reason, 'Storage integration test');

    const updated = await store.updateRow('Downtime', row.ID, { Reason: 'Updated integration test' });
    assert.equal(updated.Reason, 'Updated integration test');

    await store.upsertDeviceSyncStatus('integration-pi', {
      LastAttemptAt: '2099-12-27T01:00:00.000Z',
      LastSuccessAt: '2099-12-27T01:00:00.000Z',
      LastSourceID: 42,
      LastRowCount: 3,
      Status: 'success',
      Error: '',
    });
    await store.upsertDeviceSyncStatus('integration-pi', {
      LastAttemptAt: '2099-12-27T01:05:00.000Z',
      LastRowCount: 0,
      Status: 'success',
    });
    const device = (await store.readSheet('DeviceSyncStatus'))
      .find((item) => item.DeviceID === 'integration-pi');
    assert.equal(Number(device.LastSourceID), 42);
    assert.equal(Number(device.LastRowCount), 0);

    const backup = await store.appendRow('BackupRuns', {
      Status: 'success',
      StartedAt: '2099-12-27T01:00:00.000Z',
      CompletedAt: '2099-12-27T01:01:00.000Z',
      ObjectPath: 'test/backup.json.gz',
      SizeBytes: 1024,
      Error: '',
    });
    assert.ok(Number(backup.ID) > 0);

    assert.equal(await store.deleteRow('Downtime', row.ID), true);
    await store.deleteRowsByReportDate('Downtime', 'EntryDate', '2099-12-28');
  } finally {
    await store.close();
  }
});
