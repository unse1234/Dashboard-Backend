import type { MoneyValue } from '../common/money';
import { formatPublicId } from '../common/public-id';
import type { Currency, PaymentMethod } from '../generated/prisma/client';
import { escapeHtml } from './escape-html';
import type { MailMessage } from './mail-transport';

/** What the email says about an order: its saved snapshots, nothing read live. */
export interface OrderConfirmationDetails {
  orderNumber: number;
  customerName: string;
  currency: Currency;
  paymentMethod: PaymentMethod | null;
  /** In the order they were placed in. */
  items: {
    productName: string;
    quantity: number;
    unitPrice: MoneyValue;
    total: MoneyValue;
  }[];
  subtotal: MoneyValue;
  shipping: MoneyValue;
  tax: MoneyValue;
  discount: MoneyValue;
  total: MoneyValue;
  /** The order's shippingAddress snapshot (JSON). */
  shippingAddress: unknown;
  /** The confirmation deadline. */
  expiresAt: Date;
}

/** Delivery is within Pakistan only, so the deadline is given in its time. */
const DEADLINE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const AMOUNT_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const CURRENCY_PREFIX: Record<Currency, string> = { PKR: 'Rs ', USD: '$' };

const COUNTRY_NAMES: Record<string, string> = { PK: 'Pakistan' };

/** "Rs 1,500.00", as the storefront shows it. */
export function formatOrderAmount(
  value: MoneyValue,
  currency: Currency,
): string {
  return `${CURRENCY_PREFIX[currency]}${AMOUNT_FORMAT.format(Number(value))}`;
}

export function formatDeadline(date: Date): string {
  return `${DEADLINE_FORMAT.format(date)} (Pakistan time)`;
}

/** The delivery address as lines, read defensively from the JSON snapshot. */
export function addressLines(snapshot: unknown): {
  lines: string[];
  phone: string | null;
} {
  const record =
    snapshot && typeof snapshot === 'object'
      ? (snapshot as Record<string, unknown>)
      : {};
  const text = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.trim() !== ''
      ? value.trim()
      : null;
  };
  const country = text('country');
  const cityLine = [
    text('city'),
    [text('region'), text('postalCode')].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');
  const lines = [
    text('recipientName'),
    text('addressLine1'),
    text('addressLine2'),
    cityLine || null,
    country ? (COUNTRY_NAMES[country] ?? country) : null,
  ].filter((line): line is string => line !== null);
  return { lines, phone: text('phone') };
}

/**
 * The email that asks a shopper to confirm an order. `link` is built by the
 * caller from the configured storefront address; it is the only place the
 * token appears, and the email is the only place the link appears.
 */
export function buildOrderConfirmationEmail(
  to: string,
  details: OrderConfirmationDetails,
  link: string,
): MailMessage {
  const reference = formatPublicId('ORD', details.orderNumber);
  const money = (value: MoneyValue) =>
    formatOrderAmount(value, details.currency);
  const deadline = formatDeadline(details.expiresAt);
  const address = addressLines(details.shippingAddress);
  const hasDiscount = Number(details.discount) > 0;

  const totals: [string, string][] = [
    ['Subtotal', money(details.subtotal)],
    ['Shipping', money(details.shipping)],
    ['Tax', money(details.tax)],
    ...(hasDiscount
      ? ([['Discount', `-${money(details.discount)}`]] as [string, string][])
      : []),
    ['Total', money(details.total)],
  ];
  const payment =
    details.paymentMethod === 'COD'
      ? `Payment: cash on delivery. Pay ${money(details.total)} in cash when your order arrives; nothing is charged now.`
      : null;
  const expiryNote = `Confirm by ${deadline}. If the order is not confirmed by then, it is cancelled and the items are released.`;
  const ignoreNote =
    'If you did not place this order, ignore this email: it will be cancelled and nothing is charged.';

  const text = [
    `Hi ${details.customerName},`,
    '',
    `Please confirm your order ${reference} to complete it.`,
    '',
    `Confirm your order: ${link}`,
    '',
    expiryNote,
    '',
    `Order ${reference}`,
    ...details.items.map(
      (item) =>
        `- ${item.productName} x ${item.quantity} at ${money(item.unitPrice)} = ${money(item.total)}`,
    ),
    '',
    ...totals.map(([label, value]) => `${label}: ${value}`),
    '',
    'Delivery to:',
    ...address.lines,
    ...(address.phone ? [`Phone: ${address.phone}`] : []),
    '',
    ...(payment ? [payment, ''] : []),
    ignoreNote,
  ].join('\n');

  const cell = 'padding:4px 8px;text-align:left';
  const amountCell = 'padding:4px 8px;text-align:right';
  const html = [
    `<p>Hi ${escapeHtml(details.customerName)},</p>`,
    `<p>Please confirm your order <strong>${escapeHtml(reference)}</strong> to complete it.</p>`,
    `<p><a href="${escapeHtml(link)}">Confirm your order</a></p>`,
    `<p>${escapeHtml(expiryNote)}</p>`,
    `<table style="border-collapse:collapse"><thead><tr>`,
    `<th style="${cell}">Item</th><th style="${amountCell}">Qty</th>`,
    `<th style="${amountCell}">Price</th><th style="${amountCell}">Total</th>`,
    `</tr></thead><tbody>`,
    ...details.items.map(
      (item) =>
        `<tr><td style="${cell}">${escapeHtml(item.productName)}</td>` +
        `<td style="${amountCell}">${item.quantity}</td>` +
        `<td style="${amountCell}">${escapeHtml(money(item.unitPrice))}</td>` +
        `<td style="${amountCell}">${escapeHtml(money(item.total))}</td></tr>`,
    ),
    `</tbody><tfoot>`,
    ...totals.map(
      ([label, value]) =>
        `<tr><td style="${cell}" colspan="3">${escapeHtml(label)}</td>` +
        `<td style="${amountCell}">${escapeHtml(value)}</td></tr>`,
    ),
    `</tfoot></table>`,
    `<p><strong>Delivery to</strong><br>${[
      ...address.lines,
      ...(address.phone ? [`Phone: ${address.phone}`] : []),
    ]
      .map(escapeHtml)
      .join('<br>')}</p>`,
    ...(payment ? [`<p>${escapeHtml(payment)}</p>`] : []),
    `<p>${escapeHtml(ignoreNote)}</p>`,
  ].join('');

  return {
    to,
    subject: `Confirm your order ${reference}`,
    text,
    html,
  };
}
