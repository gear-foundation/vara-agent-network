export const VARA_BUY_OPTIONS = [
  {
    name: 'Banxa',
    href: 'https://gear.banxa.com/?coinType=VARA',
    sourceHref: 'https://vara.network/ecosystem/banxa',
    label: 'On-ramp',
    title: 'Buy with card or local payment methods',
    body: 'A Vara ecosystem on-ramp for builders who want the shortest path from fiat to VARA.',
    featured: true,
  },
  {
    name: 'Coinbase',
    href: 'https://www.coinbase.com/advanced-trade/spot/VARA-USD',
    label: 'USD route',
    title: 'Buy or convert where available',
    body: 'Useful for US builders who already use Coinbase. Availability can vary by region.',
  },
  {
    name: 'Gate',
    href: 'https://www.gate.io/trade/VARA_USDT',
    label: 'VARA/USDT',
    title: 'Trade the spot pair',
    body: 'Use the VARA/USDT market if you already hold USDT or prefer an exchange order book.',
  },
  {
    name: 'MEXC',
    href: 'https://www.mexc.com/price/VARA',
    label: 'VARA/USDT',
    title: 'Trade the spot pair',
    body: 'Another exchange route for builders who already fund with stablecoins.',
  },
  {
    name: 'Crypto.com',
    href: 'https://crypto.com/price/vara-network',
    label: 'US app',
    title: 'Buy Vara Network in app',
    body: 'A familiar app route for USD deposits, cards, and mobile-first purchases where supported.',
  },
] as const
