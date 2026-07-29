/**
 * Plain-node smoke test for the fee calculation logic - no test framework,
 * no network, no database. Run with: npx ts-node test/fee.util.test.ts
 *
 * This exists so the core money-math (the part everyone will scrutinize
 * hardest) can be verified in seconds without needing Monnify credentials
 * or a running Postgres instance.
 */
import { calculateFee } from '../src/orders/fee.util';

let failures = 0;

function assertEqual(actual: number, expected: number, label: string) {
  if (actual !== expected) {
    console.error(`FAIL: ${label} — expected ${expected}, got ${actual}`);
    failures++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

// Tiny order: 1% of 100 is ₦1, which is below the ₦10 floor, so floor applies.
{
  const { platformFee, netAmount } = calculateFee(100);
  assertEqual(platformFee, 10, 'tiny order hits fee floor');
  assertEqual(netAmount, 90, 'tiny order net amount');
}

// Mid-size order: 1% of 5000 = 50, comfortably between floor and cap.
{
  const { platformFee, netAmount } = calculateFee(5000);
  assertEqual(platformFee, 50, 'mid order uses flat 1%');
  assertEqual(netAmount, 4950, 'mid order net amount');
}

// Large order: 1% of 200,000 = 2000, which exceeds the ₦500 cap, so cap applies.
{
  const { platformFee, netAmount } = calculateFee(200_000);
  assertEqual(platformFee, 500, 'large order hits fee cap');
  assertEqual(netAmount, 199_500, 'large order net amount');
}

// Boundary check: exactly at the floor threshold (1% of 1000 = 10).
{
  const { platformFee } = calculateFee(1000);
  assertEqual(platformFee, 10, 'boundary order at exactly the floor');
}

// Boundary check: exactly at the cap threshold (1% of 50,000 = 500).
{
  const { platformFee } = calculateFee(50_000);
  assertEqual(platformFee, 500, 'boundary order at exactly the cap');
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll fee calculation tests passed.');
}
