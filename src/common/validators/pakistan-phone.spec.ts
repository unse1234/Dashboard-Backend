import { normalizePakistanPhone } from './pakistan-phone';

describe('normalizePakistanPhone', () => {
  it.each([
    ['03001234567', '+923001234567'],
    ['0300 1234567', '+923001234567'],
    ['0300-1234567', '+923001234567'],
    ['(0300) 123 4567', '+923001234567'],
    ['3001234567', '+923001234567'],
    ['+92 300 1234567', '+923001234567'],
    ['+92-300-1234567', '+923001234567'],
    ['+92 0300 1234567', '+923001234567'],
    ['0092 300 1234567', '+923001234567'],
    ['923001234567', '+923001234567'],
    ['  03451234567  ', '+923451234567'],
  ])('accepts the mobile %p', (input, expected) => {
    expect(normalizePakistanPhone(input)).toBe(expected);
  });

  it.each([
    ['042 35761234', '+924235761234'],
    ['021-34567890', '+922134567890'],
    ['051 2345678', '+92512345678'],
    ['0544-123456', '+92544123456'],
    ['+92 42 35761234', '+924235761234'],
    ['091 5123456', '+92915123456'],
  ])('accepts the landline %p', (input, expected) => {
    expect(normalizePakistanPhone(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'abc',
    '0300 123456', // too short
    '0300 12345678', // too long for a mobile
    '+1 415 555 0100', // not Pakistan
    '+44 7700 900123',
    '0300 123 456a',
    '0300-1234567 ext 5',
    '0100 1234567', // no Pakistani number starts 01
    '+92',
    '00',
    '1234567890123456',
  ])('refuses %p', (input) => {
    expect(normalizePakistanPhone(input)).toBeNull();
  });
});
