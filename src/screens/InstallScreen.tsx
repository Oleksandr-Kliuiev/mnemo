import { CheckCircle2, PlusSquare, Share, ShieldCheck, WifiOff } from 'lucide-react'
import { Screen, Section } from '../ui/Screen'
import { isIOS, isStandalone } from '../lib/platform'
import { href } from '../lib/router'

export default function InstallScreen() {
  const installed = isStandalone()
  return (
    <Screen title="Установка на iPhone" large={false} back={{ label: 'Назад', fallback: '/settings' }}>
      {installed ? (
        <div className="banner" style={{ marginTop: 'var(--s-2)' }}>
          <span className="banner__icon" style={{ background: 'var(--good-tint)', color: 'var(--good)' }} aria-hidden>
            <CheckCircle2 size={20} />
          </span>
          <div className="banner__body">
            <span className="banner__title">Mnemo уже установлено</span>
            Приложение открыто с экрана «Домой» и работает без интернета.
          </div>
        </div>
      ) : (
        <Section title="Три шага в Safari" footer={isIOS() ? undefined : 'Откройте эту страницу на iPhone в Safari — там появится нужная кнопка.'}>
          <ol className="steps">
            <li>
              <span className="steps__num" aria-hidden>
                1
              </span>
              <span>
                Нажмите <strong>«Поделиться»</strong> <Share size={18} className="inline-icon" aria-hidden /> на панели Safari.
              </span>
            </li>
            <li>
              <span className="steps__num" aria-hidden>
                2
              </span>
              <span>
                Прокрутите меню и выберите <strong>«На экран „Домой“»</strong> <PlusSquare size={18} className="inline-icon" aria-hidden />.
              </span>
            </li>
            <li>
              <span className="steps__num" aria-hidden>
                3
              </span>
              <span>
                Нажмите <strong>«Добавить»</strong>. Иконка Mnemo появится рядом с другими приложениями.
              </span>
            </li>
          </ol>
        </Section>
      )}

      <Section title="Что важно знать">
        <div className="stack">
          <div className="banner">
            <span className="banner__icon" aria-hidden>
              <WifiOff size={20} />
            </span>
            <div className="banner__body">
              <span className="banner__title">Работает без интернета</span>
              После первого открытия Mnemo хранит всё на телефоне. Новые версии ставятся сами, когда есть сеть.
            </div>
          </div>
          <div className="banner">
            <span className="banner__icon" aria-hidden>
              <ShieldCheck size={20} />
            </span>
            <div className="banner__body">
              <span className="banner__title">Бесплатно и без срока</span>
              Это веб-приложение: ему не нужна подписка разработчика Apple и переустановка раз в 7 дней.
            </div>
          </div>
          <div className="banner banner--warning">
            <div className="banner__body">
              <span className="banner__title">Safari и приложение хранят данные отдельно</span>
              Если вы уже добавили карточки в Safari, сохраните резервную копию в{' '}
              <a href={href('/settings?focus=backup')}>настройках</a>, а после установки восстановите её в приложении.
            </div>
          </div>
        </div>
      </Section>
    </Screen>
  )
}
