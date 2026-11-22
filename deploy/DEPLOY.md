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
BRIDGE_IMAGE=simply-bridge:current
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

להתקנת גרסה חדשה: העבירו ZIP חדש, שמרו את קובץ .env הקיים, עדכנו את BRIDGE_IMAGE לגרסה החדשה והפעילו install-offline.sh. האחסון יישמר. הכספת המקומית ממחשב הפיתוח אינה מועברת אוטומטית. החל מגרסה 0.23.0, תוכניות ייבוא, קלטים, התקדמות ותקלות נשמרים מוצפנים באותו volume. אחרי החלפת קונטיינר נכנסים לכספת, פותחים את הפעולה המושהית ולוחצים "המשך מאותה נקודה". אין להריץ `down -v`.

## תעודת CA ארגונית עבור חיבור SIMPLY
אם HTTPS של SIMPLY חתום ב־CA ארגוני, שימו קובץ PEM בשם organization-ca.pem לצד compose.yaml והפעילו:

```bash
docker compose -f compose.yaml -f compose-ca.yaml up -d --pull never --no-build
```

השתמשו באותם שני קובצי compose גם בשדרוגים. אין לבטל בדיקת תעודות. קובץ ה־CA אינו נכלל בחבילה; הוא מסופק בסביבת היעד.

## נתיב מאחורי Proxy — אופציונלי בלבד
למרות שהפריסה המתוכננת היא שרת ופורט ישירים, ניתן להגדיר PUBLIC_URL=https://server/bridge/ בהמשך. ה־proxy צריך להעביר את הנתיב /bridge/ ללא הסרה ולשמור את Host הציבורי. היישום אינו סומך על X-Forwarded-Host. אם ה־proxy באותו שרת, ניתן להגדיר BIND_IP=127.0.0.1. נדרשת התאמת מגבלת גוף הבקשה ל־10MB וזמן המתנה מספיק ל־Dry Run.

ייבוא וייצוא ממשיכים כתהליכי רקע גם לאחר ניתוק הדפדפן. ייבוא גדול נבדק ונכתב באצוות; מכסה שעתית נשמרת לכל חיבור, ותגובה מסוג `max_api_calls` משהה את הריצה במקום להפיל אותה.

## עדכון בקובץ יחיד עם Podman

הגדירו פעם אחת בקובץ `.env` הקיים:

```dotenv
BRIDGE_IMAGE=simply-bridge:current
```

בכל גרסה חדשה העבירו לשרת רק את `simply-bridge-update.tar`, ואז מתוך התיקייה שבה נמצאים קובצי ה־Compose וה־`.env` הקיימים:

```bash
podman load -i /path/to/simply-bridge-update.tar
podman compose up -d --no-build --force-recreate
podman compose ps
podman compose logs --tail 100 bridge
```

אין לבצע `down -v`. טעינת ה־image אינה משנה את `.env`, את קובצי ה־Compose, את תעודת הארגון או את ה־volume. ה־TAR כולל גם תג ממוספר לצורך חזרה לגרסה קודמת.

## Automatic recovery of background imports

To enable recovery before a user signs in, provision a secret file containing
32 raw random bytes. Mount it read-only outside the application data volume
and set `BRIDGE_RECOVERY_KEY_FILE` to its path inside the container. The file
must be readable by the container's application user. Keep the key separate
from data-volume backups. Together, the key and backup can decrypt the vault
and the job data.

The application saves an encrypted recovery record when an authenticated
user starts or resumes a background import. After restart, it resumes eligible
running imports against their original connection. Jobs paused for intervention
and jobs explicitly stopped remain available for authenticated handling.
If an interrupted write cannot be confirmed from destination values, the
application records it for review and proceeds with independent records.

## Relation processing

Both relation features are opt-in. Mount configuration files read-only and
use the container paths in the environment variables below. The files use
Origami data names and Bridge connection IDs. Configure the same settings
when restarting a container.

### Import Relation Finalizer

Set `BRIDGE_RELATION_RULES_FILE` to a JSON object keyed by destination Bridge
connection ID. Each value is an array of rule objects, for example:

```json
{
  "destination-connection-id": [
    {
      "sourceEntity": "source_issues",
      "sourceRelatedEntity": "source_inventory",
      "groupId": "destination_group",
      "fieldId": "destination_inventory_relation",
      "targetEntity": "destination_inventory",
      "targetKey": {
        "kind": "field",
        "groupId": "destination_inventory_group",
        "fieldId": "external_key"
      },
      "valueMode": "sourceText"
    }
  ]
}
```

Use `sourceText` for a source label stored in the target matching field,
`sourceId` for a target matching field holding the original source ID, or
`packageKey` for the related record's exported match key. Historical presets
can keep the same relation staging field. Assign a single writer to these
relations by disabling the Node-RED relation workflow for imports managed by
the Finalizer. Verify the clear and multi-value formats in a representative
test environment before enabling writes.

### BLACK issue webhook

Set `BRIDGE_BLACK_CONFIG_FILE` and `BRIDGE_BLACK_TOKEN_FILE`, alongside
`BRIDGE_RECOVERY_KEY_FILE`. The administrator opens the vault once after
configuration so the webhook can accept jobs without a browser session.
The token file holds one random URL-safe token of at least 32 characters.

```json
{
  "connectionId": "black-connection-id",
  "issueEntity": "issues",
  "source": {
    "base": "original_base",
    "building": "original_building",
    "floor": "original_floor",
    "room": "original_room",
    "topic": "subject",
    "item": "item_name"
  },
  "destination": {
    "base": "base_relation",
    "building": "building_relation",
    "floor": "floor_relation",
    "room": "room_relation",
    "inventory": "inventory_relation"
  },
  "base": {"entity": "bases", "name": "_id"},
  "building": {"entity": "buildings", "name": "name", "base": "base"},
  "floor": {"entity": "floors", "name": "name", "building": "building", "base": "base"},
  "room": {"entity": "rooms", "name": "name", "floor": "floor", "building": "building", "base": "base"},
  "catalog": {"entity": "catalog", "name": "name", "topic": "subject"},
  "inventory": {"entity": "inventory", "base": "base", "building": "building", "floor": "floor", "topic": "subject", "catalog": "catalog_item"}
}
```

Send `POST /api/issues/resolve` with a JSON body containing `issueId` and
`Authorization: Bearer <token>`. Use an HTTPS endpoint for the bearer token.
Poll `POST /api/issues/status` with the same authorization and the returned
`jobId`. Match queries send `with_archive: 0`; verify filtering with a sample
that has both active and archived matches before enabling the integration.
