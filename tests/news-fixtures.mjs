// Réponses fictives pour l'onglet Actu : flux RSS, Google News, pages Telegram publiques et traduction.
// Les autres médias de la liste ne répondent pas (404), pour vérifier qu'une source en panne ne bloque rien.

const HOUR = 3600_000;

const rss = items => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Flux</title>${items.map(i => `
  <item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><pubDate>${new Date(i.time).toUTCString()}</pubDate>${i.source ? `<source url="https://example.com">${i.source}</source>` : ''}</item>`).join('')}
</channel></rss>`;

const telegram = (channel, posts) => `<!DOCTYPE html><html><body><section class="tgme_channel_history">${posts.map(p => `
  <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${channel}/${p.id}" data-view="x">
    <div class="tgme_widget_message_text js-message_text" dir="auto">${p.html}</div>
    <div class="tgme_widget_message_footer"><a class="tgme_widget_message_date" href="https://t.me/${channel}/${p.id}"><time datetime="${new Date(p.time).toISOString().replace('.000Z', '+00:00')}" class="time">12:00</time></a></div>
  </div></div>`).join('')}</section></body></html>`;

export function routeNews(url, now = Date.now()) {
  const u = new URL(url);
  const ago = h => now - h * HOUR;
  const gn = (title, source, h) => ({ title: `${title} - ${source}`, source, link: `https://news.google.com/rss/articles/${encodeURIComponent(title).slice(0, 40)}${source.length}`, time: ago(h) });
  switch (u.host) {
    case 'news.google.com': {
      const q = u.searchParams.get('q') || '';
      if (q.startsWith('(OPEC')) {
        return rss([
          gn('OPEC+ agrees to cut oil output by 500,000 barrels per day', 'Reuters', 1),
          gn('OPEC+ agrees to cut oil output by 500,000 bpd from November', 'Bloomberg', 0.8),
          gn('Gold prices climb as dollar weakens', 'Kitco', 3),
        ]);
      }
      if (q.startsWith('(Iran')) return rss([gn('Israel and Hamas agree to ceasefire deal in Gaza', 'Associated Press', 5)]);
      if (q.startsWith('("Federal Reserve"')) return rss([gn('Fed holds rates steady, signals patience on further cuts', 'CNBC', 6)]);
      if (q.startsWith('(crypto')) return rss([gn('Ether ETFs record $650 million in inflows', 'The Block', 4)]);
      return rss([]);
    }
    case 'www.federalreserve.gov':
      return rss([{ title: 'Federal Reserve issues FOMC statement', link: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261001a.htm', time: ago(6.2) }]);
    case 'www.ecb.europa.eu':
      return rss([
        { title: 'ECB publishes supervisory banking statistics', link: 'https://www.ecb.europa.eu/press/pr/1.html', time: ago(2) },
        { title: 'Monetary policy decisions', link: 'https://www.ecb.europa.eu/press/pr/2.html', time: ago(20) },
      ]);
    case 'www.sec.gov':
      return rss([
        { title: 'SEC Charges Investment Adviser for Misleading Investors', link: 'https://www.sec.gov/newsroom/press-releases/1', time: ago(3) },
        { title: 'SEC Charges Crypto Platform Founder with Fraud', link: 'https://www.sec.gov/newsroom/press-releases/2', time: ago(2) },
      ]);
    case 'www.coindesk.com':
      return rss([
        { title: 'Hackers drain $72 million from lending protocol', link: 'https://www.coindesk.com/a', time: ago(1.5) },
        { title: 'Nebula DEX launches v2 with fee buybacks', link: 'https://www.coindesk.com/b', time: ago(2.5) },
        { title: 'Bitcoin price analysis: bulls eye resistance', link: 'https://www.coindesk.com/c', time: ago(2) },
      ]);
    case 't.me': {
      if (u.searchParams.get('before')) return telegram('whale_alert_io', []);
      if (u.pathname === '/s/whale_alert_io') {
        return telegram('whale_alert_io', [
          { id: 101, time: ago(0.5), html: '🚨 🚨 1,500 #BTC (150,123,456 USD) transferred from unknown wallet to #Coinbase<br/><br/><a href="https://whale-alert.io/tx/1">Details</a>' },
          { id: 102, time: ago(0.4), html: '🚨 120 #ETH (450,000 USD) transferred from unknown wallet to #Binance' },
          { id: 103, time: ago(0.3), html: '💵 💵 250,000,000 #USDT (250,001,234 USD) minted at Tether Treasury' },
        ]);
      }
      if (u.pathname === '/s/WatcherGuru') {
        return telegram('WatcherGuru', [{ id: 9, time: ago(0.2), html: 'JUST IN: 🇺🇸 Trump announces new 100% tariffs on Chinese imports.' }]);
      }
      return '<html><body>Aucun message</body></html>';
    }
    case 'translate.googleapis.com': {
      const q = u.searchParams.get('q');
      return [[[`FR ${q}`, q, null, null, 10]], null, 'en'];
    }
    default:
      return undefined;
  }
}
