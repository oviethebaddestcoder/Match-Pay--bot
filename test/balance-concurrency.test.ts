/**
 * Standalone concurrency smoke test - NOT part of the Nest app, just a
 * direct TypeORM connection to a throwaway SQLite file. Verifies the
 * atomic UPDATE pattern used in SellersService actually prevents a
 * double-withdrawal race, by firing 20 concurrent debit attempts against
 * a balance that can only satisfy 10 of them, and checking exactly 10
 * succeed and the final balance is exactly zero.
 *
 * Run with: npx ts-node test/balance-concurrency.test.ts
 */
import { DataSource } from 'typeorm';
import { Seller } from '../src/sellers/seller.entity';
import { Order } from '../src/orders/order.entity';
import { Withdrawal } from '../src/withdrawals/withdrawal.entity';
import * as fs from 'fs';

const DB_FILE = './test-concurrency.sqlite';

async function main() {
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const dataSource = new DataSource({
    type: 'better-sqlite3',
    database: DB_FILE,
    entities: [Order, Seller, Withdrawal],
    synchronize: true,
  });
  await dataSource.initialize();

  const sellerRepo = dataSource.getRepository(Seller);
  const seller = await sellerRepo.save(
    sellerRepo.create({ whatsappNumber: '2348000000000', balance: 1000 }),
  );

  // Atomic conditional debit - mirrors SellersService.debitBalanceForWithdrawal exactly.
  async function debit(amount: number): Promise<boolean> {
    const result = await sellerRepo
      .createQueryBuilder()
      .update(Seller)
      .set({ balance: () => 'balance - :amount' })
      .where('id = :id AND balance >= :amount')
      .setParameters({ amount, id: seller.id })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  // Fire 20 concurrent ₦100 debit attempts against a ₦1000 balance.
  // Exactly 10 should succeed; the other 10 should cleanly fail.
  const attempts = Array.from({ length: 20 }, () => debit(100));
  const results = await Promise.all(attempts);

  const succeeded = results.filter(Boolean).length;
  const failed = results.length - succeeded;

  const finalSeller = await sellerRepo.findOneOrFail({ where: { id: seller.id } });
  const finalBalance = Number(finalSeller.balance);

  console.log(`Succeeded: ${succeeded} (expected 10)`);
  console.log(`Failed: ${failed} (expected 10)`);
  console.log(`Final balance: ${finalBalance} (expected 0)`);

  await dataSource.destroy();
  fs.unlinkSync(DB_FILE);
  if (fs.existsSync(`${DB_FILE}-wal`)) fs.unlinkSync(`${DB_FILE}-wal`);
  if (fs.existsSync(`${DB_FILE}-shm`)) fs.unlinkSync(`${DB_FILE}-shm`);

  if (succeeded !== 10 || finalBalance !== 0) {
    console.error('\nFAIL: concurrent debits were not handled atomically.');
    process.exit(1);
  }
  console.log('\nPASS: no over-withdrawal occurred under concurrent load.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
