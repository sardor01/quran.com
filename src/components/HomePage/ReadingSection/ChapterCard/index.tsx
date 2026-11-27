import React, { useContext } from 'react';

import useTranslation from 'next-translate/useTranslation';

import styles from './ChapterCard.module.scss';

import Card from '@/components/HomePage/Card';
import DataContext from '@/contexts/DataContext';
import Button, { ButtonSize } from '@/dls/Button/Button';
import IconContainer, { IconSize } from '@/dls/IconContainer/IconContainer';
import ArrowIcon from '@/icons/arrow.svg';
import { getChapterData } from '@/utils/chapter';
import { logButtonClick } from '@/utils/eventLogger';
import { toLocalizedNumber } from '@/utils/locale';
import { getChapterWithStartingVerseUrl, getPageNavigationUrl } from '@/utils/navigation';
import { isMobile } from '@/utils/responsive';

type Props = {
  surahNumber: number;
  verseNumber?: number;
  pageNumber?: number;
  isContinueReading?: boolean;
};

const ChapterCard: React.FC<Props> = ({
  surahNumber,
  verseNumber = 1,
  pageNumber = 0,
  isContinueReading = false,
}) => {
  const { t, lang } = useTranslation('home');
  const chaptersData = useContext(DataContext);
  const surahNumberString = surahNumber.toString();
  const chapterData = getChapterData(chaptersData, surahNumberString);

  const onContinueReadingClicked = () => {
    logButtonClick('homepage_chapter_card_continue_reading');
  };

  const onBeginClicked = () => {
    logButtonClick('homepage_chapter_card_begin');
  };

  const link = pageNumber
    ? getPageNavigationUrl(pageNumber)
    : getChapterWithStartingVerseUrl(`${surahNumber}:${verseNumber}`);

  return (
    <Card className={styles.chapterCard} link={link} testId="chapter-card">
      <div className={styles.surahContainer}>
        <div className={styles.surahName} translate="no">
          {surahNumberString.padStart(3, '0')}
        </div>
        <div className={styles.surahInfo}>
          <div>
            <span className={styles.transliteratedName} translate="no">
              {toLocalizedNumber(surahNumber, lang)}. {chapterData.transliteratedName}
            </span>
            <span className={styles.translatedName} translate="no">
              {' '}
              {isMobile() ? `${chapterData.translatedName}` : `(${chapterData.translatedName})`}
            </span>
          </div>
          {/* The whole card is already a link to `link` (see Card), so these must not render their own
              <a>: nested anchors are invalid HTML and the browser splits them, breaking hydration. */}
          {isContinueReading ? (
            // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
            <div className={styles.continueReading} onClick={onContinueReadingClicked}>
              <span>{t('common:verse')}</span>
              <span>{toLocalizedNumber(verseNumber, lang)}</span>
              <IconContainer
                size={IconSize.Xsmall}
                icon={<ArrowIcon />}
                shouldForceSetColors={false}
                className={styles.continueReadingArrowIcon}
              />
            </div>
          ) : (
            <Button size={ButtonSize.Small} onClick={onBeginClicked} className={styles.beginButton}>
              {t('begin')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
};

export default ChapterCard;
