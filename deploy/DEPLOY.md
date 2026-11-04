# SIMPLY BRIDGE — פריסה ב־Linux ללא אינטרנט

## מצב החבילה
חבילת המקור כוללת Dockerfile, הגדרות פריסה וסקריפט ליצירת ZIP להעברה לרשת מנותקת. היא אינה כוללת image בנוי. בנייה ובדיקת קונטיינר מחייבות מחשב עם Docker; הן לא בוצעו בסביבת הפיתוח הנוכחית. אין תלויות npm ואין צורך ב־npm install.

## הכנה מחוץ לרשת האדומה
נדרשים Linux עם Docker פעיל, zip ו־sha256sum, וגישה להורדת image הבסיס. לאחר חילוץ חבילת המקור, מתוך תיקיית היישום:

```bash
bash deploy/build-offline.sh
```

ברירת המחדל היא linux/amd64. לשרת ARM64:

```bash
PLATFORM=linux/arm64 bash deploy/build-offline.sh
```

אפשר לקבע בסיס מאושר באמצעות NODE_IMAGE (כולל digest). הסקריפט בונה image, מריץ את הבדיקות בקונטיינר ללא רשת חיצונית, ואז שומר image.tar, פרטי image, הוראות, הגדרות ובדיקות SHA256 לתוך ZIP. הוא נעצר אם הבנייה או הבדיקות נכשלו. אין בחבילה כספת, פרטי חיבורים או נתוני משתמש. הארכיטקטורה של ה־image חייבת להתאים לשרת היעד.

## התקנה ברשת האדומה
נדרשים Docker Engine ותוסף Docker Compose מותקנים מראש (ה־ZIP אינו מתקין אותם). חלצו את ה־ZIP שנוצר לנתיב קבוע, למשל /opt/simply-bridge, והפעילו:

```bash
bash install-offline.sh
```

בהפעלה הראשונה ייווצר .env והסקריפט יעצור כדי שתגדירו את כתובת השרת. לדוגמה:

```dotenv
PUBLIC_URL=http://10.20.30.40:4318/
HOST_PORT=4318
BIND_IP=0.0.0.0
BRIDGE_IMAGE=simply-bridge:0.15.0
DATA_VOLUME=simply-bridge-data
```

הפעילו שוב את הסקריפט. הוא יבדוק SHA256, יטען את ה־image ויפעיל את היישום בלי build ובלי pull. פתחו בדפדפן את PUBLIC_URL. צריך לפתוח גישה לפורט הזה ברשת ולהבטיח שהקונטיינר יכול להגיע ל־DNS ול־API של SIMPLY. בכניסה הראשונה מגדירים סיסמת כספת וחיבור לסביבה האדומה.

```bash
docker compose ps
docker compose logs --tail 100 bridge
```

PUBLIC_URL היא הכתובת המדויקת שבה משתמשים בדפדפן; פנייה בשם או IP אחר תידחה. הפורט בתוך הקונטיינר נשאר 4318; HOST_PORT הוא הפורט בשרת. שינוי PUBLIC_URL או HOST_PORT אינו מחייב שינוי קוד. ב־HTTP התעבורה אינה מוצפנת; להפעלת HTTPS אפשר להציב TLS לפני היישום ולהגדיר כתובת https תואמת.

## נתונים ושדרוגים
הכספת והפריסטים נשמרים מוצפנים ב־Docker volume בשם simply-bridge-data. הקונטיינר רץ כמשתמש node (UID 1000), מערכת הקבצים שלו לקריאה בלבד, והכתיבה מתבצעת ב־volume. שמרו את DATA_VOLUME קבוע בשדרוג. אל תפעילו docker compose down -v אם רוצים לשמור נתונים.

לפני שדרוג, בסיום פעולות RUN פעילות, עצרו וגבו את הכספת (אחרי שכבר נוצרה):

```bash
docker compose stop bridge
docker compose cp bridge:/app/data/connections.vault.json ./backup.vault.json
docker compose start bridge
```

להתקנת גרסה חדשה: העבירו ZIP חדש, שמרו את קובץ .env הקיים, עדכנו את BRIDGE_IMAGE לגרסה החדשה והפעילו install-offline.sh. האחסון יישמר. הכספת המקומית ממחשב הפיתוח אינה מועברת אוטומטית. התחברות מחודשת ו־Dry Run חדש נדרשים אחרי החלפת קונטיינר; תוכניות פעילות אינן ממשיכות אוטומטית.

## תעודת CA ארגונית עבור חיבור SIMPLY
אם HTTPS של SIMPLY חתום ב־CA ארגוני, שימו קובץ PEM בשם organization-ca.pem לצד compose.yaml והפעילו:

```bash
docker compose -f compose.yaml -f compose-ca.yaml up -d --pull never --no-build
```

השתמשו באותם שני קובצי compose גם בשדרוגים. אין לבטל בדיקת תעודות. קובץ ה־CA אינו נכלל בחבילה; הוא מסופק בסביבת היעד.

## נתיב מאחורי Proxy — אופציונלי בלבד
למרות שהפריסה המתוכננת היא שרת ופורט ישירים, ניתן להגדיר PUBLIC_URL=https://server/bridge/ בהמשך. ה־proxy צריך להעביר את הנתיב /bridge/ ללא הסרה ולשמור את Host הציבורי. היישום אינו סומך על X-Forwarded-Host. אם ה־proxy באותו שרת, ניתן להגדיר BIND_IP=127.0.0.1. נדרשת התאמת מגבלת גוף הבקשה ל־10MB וזמן המתנה מספיק ל־Dry Run.

אין כיום שירות אוטומציה ברקע; גרסה זו מפעילה את ה־GUI ואת מנגנון ההעברה הקיים. תהליכים אוטומטיים יתווספו בגרסאות נפרדות.
