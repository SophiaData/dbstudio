//! Public pagination evidence from the dedicated native-database-fixture containers only.
//! Run with --ignored --test-threads=1. No destructive SQL or application credentials.
use dbstudio_protocol::{ConnectionConfig, Driver, SecretMap};
use mysql::prelude::Queryable;
use serde_json::{json, Value};
use std::{fs::{self, OpenOptions}, io::Write, path::Path, time::Instant};

const REPEATS: usize = 5;
const BATCH: usize = 10_000;
const BIG_BASE: u64 = 9_007_199_254_740_993;

// Database errors may embed connection details. Never print/debug the original error.
fn required<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("page performance: {stage} failed; private details withheld"))
}

enum Observer {
    Pg(postgres::Client),
    Mysql(mysql::Conn),
}
impl Observer {
    fn connect(dialect: &str, port: u16, password: &str) -> Self {
        if dialect == "postgresql" {
            let mut config = postgres::Config::new();
            config.host("127.0.0.1").port(port).user("fixture").password(password).dbname("fixture");
            Self::Pg(required(config.connect(postgres::NoTls), "independent PostgreSQL connection"))
        } else {
            let options = mysql::OptsBuilder::new().ip_or_hostname(Some("127.0.0.1"))
                .tcp_port(port).user(Some("fixture")).pass(Some(password)).db_name(Some("fixture"));
            let mut conn = required(mysql::Conn::new(options), "independent MySQL connection");
            required(conn.query_drop("SET NAMES utf8mb4"), "fixture encoding");
            Self::Mysql(conn)
        }
    }
    fn execute(&mut self, sql: &str) {
        match self {
            Self::Pg(conn) => required(conn.batch_execute(sql), "fixture seed batch"),
            Self::Mysql(conn) => required(conn.query_drop(sql), "fixture seed batch"),
        }
    }
    fn version(&mut self) -> String {
        match self {
            Self::Pg(conn) => required(conn.query_one("SHOW server_version", &[]), "server version").get(0),
            Self::Mysql(conn) => required(conn.query_first::<String, _>("SELECT VERSION()"), "server version")
                .expect("fixture version required"),
        }
    }
    fn total(&mut self, table: &str) -> u64 {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        match self {
            Self::Pg(conn) => required(conn.query_one(sql.as_str(), &[]), "independent total").get::<_, i64>(0) as u64,
            Self::Mysql(conn) => required(conn.query_first::<u64, _>(sql), "independent total")
                .expect("fixture count required"),
        }
    }
}

fn call(driver: &mut dyn Driver, method: &str, args: Vec<Value>) -> Value {
    required(driver.call(method, args), method)
}

fn write_public(dir: &Path, name: &str, value: &Value) {
    let mut file = required(OpenOptions::new().write(true).create_new(true).open(dir.join(name)), "new public artifact");
    required(serde_json::to_writer_pretty(&mut file, value), "public JSON serialization");
    required(file.write_all(b"\n"), "public JSON write");
}

fn seed(observer: &mut Observer, dialect: &str, table: &str, rows: usize) {
    let suffix = if dialect == "mysql" { " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" } else { "" };
    observer.execute(&format!("CREATE TABLE {table} (id INTEGER PRIMARY KEY, big BIGINT NOT NULL, amount DECIMAL(30,18) NOT NULL, body VARCHAR(80) NOT NULL){suffix}"));
    for start in (1..=rows).step_by(BATCH) {
        let end = (start + BATCH - 1).min(rows);
        let source = if dialect == "postgresql" {
            format!("generate_series({start},{end}) AS series(n)")
        } else {
            let digits = "(SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
            format!("(SELECT {start}+a.d+10*b.d+100*c.d+1000*d.d AS n FROM {digits} a CROSS JOIN {digits} b CROSS JOIN {digits} c CROSS JOIN {digits} d) AS series")
        };
        let body = if dialect == "postgresql" { "'分页验收中文-' || n::text" } else { "CONCAT('分页验收中文-',n)" };
        observer.execute(&format!("INSERT INTO {table} (id,big,amount,body) SELECT n,{BIG_BASE}+n,CAST(n AS DECIMAL(30,18))+CAST('0.123456789012345678' AS DECIMAL(30,18)),{body} FROM {source} WHERE n <= {end} ORDER BY n"));
    }
}

fn validate_page(page: &Value, rows: usize, offset: usize, size: usize) {
    assert_eq!(page["offset"], offset);
    assert_eq!(page["returned"], size);
    assert_eq!(page["hasMore"], offset + size < rows);
    let columns = page["columns"].as_array().expect("native columns");
    assert_eq!(columns.len(), 4);
    for (column, name) in columns.iter().zip(["id", "big", "amount", "body"]) {
        assert_eq!(column["name"], name);
    }
    let values = page["rows"].as_array().expect("native rows");
    assert_eq!(values.len(), size);
    for (position, row) in values.iter().enumerate() {
        let id = offset + position + 1;
        assert_eq!(row["index"], id - 1);
        let cells = row["cells"].as_array().expect("native cells");
        assert_eq!(cells.len(), 4);
        assert_eq!(cells[0]["kind"], "number");
        assert_eq!(cells[0]["value"].as_f64(), Some(id as f64));
        for (cell, text) in cells[1..].iter().zip([
            (BIG_BASE + id as u64).to_string(),
            format!("{id}.123456789012345678"),
            format!("分页验收中文-{id}"),
        ]) {
            assert_eq!(cell["kind"], "text");
            assert_eq!(cell["text"], text);
            assert_ne!(cell["truncated"], true);
        }
    }
}

fn run(dialect: &str) {
    // The orchestrator sets this only after starting and checking labelled containers.
    // No configurable host/database/user or connection URL can redirect this fixture.
    let run_id = required(std::env::var("DBSTUDIO_PAGE_PERF_FIXTURE_ID"), "fixture ownership marker");
    assert!(run_id.len() == 16 && run_id.bytes().all(|c| c.is_ascii_hexdigit()), "invalid fixture marker");
    let sha = required(std::env::var("GITHUB_SHA"), "source SHA");
    assert!([40, 64].contains(&sha.len()) && sha.bytes().all(|c| c.is_ascii_hexdigit()), "invalid source SHA");
    let dir = required(std::env::var("DBSTUDIO_PAGE_PERF_DIR"), "public output directory");
    let dir = Path::new(&dir);
    assert!(dir.is_absolute(), "public output directory must be absolute");
    required(fs::create_dir_all(dir), "public output directory");
    let prefix = if dialect == "postgresql" { "DBSTUDIO_NATIVE_PG" } else { "DBSTUDIO_NATIVE_MYSQL" };
    let port: u16 = required(required(std::env::var(format!("{prefix}_PORT")), "fixture port").parse(), "fixture port");
    assert!(port > 0, "fixture port must be positive");
    let password = required(std::env::var(format!("{prefix}_PASSWORD")), "fixture password");
    assert!(!password.is_empty(), "fixture password is required");
    let config: ConnectionConfig = required(serde_json::from_value(json!({
        "dialectId": dialect, "name": "page-performance-fixture",
        "options": {"host":"127.0.0.1","port":port,"database":"fixture","user":"fixture","sslmode":"disable"}
    })), "fixture config");
    let mut secrets = SecretMap::new();
    secrets.insert("dbPassword".into(), json!(password));
    let mut seeder = Observer::connect(dialect, port, &password);
    let version = seeder.version();
    assert!(version.starts_with(if dialect == "postgresql" { "17." } else { "8.0." }), "unexpected fixture server major version");
    let environment = json!({"os":std::env::consts::OS,"arch":std::env::consts::ARCH,
        "engineVersion":version,"image":if dialect == "postgresql" {"postgres:17"} else {"mysql:8.0"},
        "containerMemoryMiB":if dialect == "postgresql" {512} else {1024},
        "workers":1,"seedBatchRows":BATCH,"cachePolicy":"no cache flush; all five samples retained"});
    let mut cases = vec![];
    let mut totals = vec![];
    for rows in [100_000usize, 1_000_000] {
        let name = format!("page_perf_{run_id}_{rows}");
        let table = if dialect == "postgresql" { format!("\"public\".\"{name}\"") } else { format!("`fixture`.`{name}`") };
        seed(&mut seeder, dialect, &table, rows);
        // A fresh raw client independently observes committed rows, outside measured calls.
        let mut observer = Observer::connect(dialect, port, &password);
        let total = observer.total(&table);
        assert_eq!(total, rows as u64);
        totals.push(json!({"rows":rows,"independentTotal":total,"connection":"independent raw database client"}));
        let mut driver = required(dbstudio_drivers::connect(&config, &secrets), "native driver connect");
        let sql = format!("SELECT id,big,amount,body FROM {table} ORDER BY id ASC");
        for size in [200usize, 1000] {
            let mut samples: [Vec<Value>; 3] = std::array::from_fn(|_| vec![]);
            let offsets = [0, size, rows - size];
            let labels = ["first", "next", "deep"];
            for repeat in 0..REPEATS {
                let start = Instant::now();
                let first = call(&mut *driver, "runQuery", vec![json!(sql), json!({"offset":0,"limit":size,"keepCursor":true})]);
                let first_wall = start.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(first["stable"], false, "large table must exercise the live pagination path");
                assert!(first["cursorId"].is_string());
                assert!(first["elapsedMs"].is_number());
                let query = json!({"cursorId":first["cursorId"],"executedSql":first["executedSql"],"elapsedMs":first["elapsedMs"]});
                let cursor = first["cursorId"].clone();
                let mut first = Some(first);
                for index in 0..3 {
                    let offset = offsets[index];
                    let method = if index == 0 { "runQuery" } else { "fetchResultPage" };
                    let (page, wall_ms) = if index == 0 {
                        (first.take().expect("first native page"), first_wall)
                    } else {
                        let start = Instant::now();
                        let page = call(&mut *driver, method, vec![cursor.clone(), json!(offset), json!(size)]);
                        (page, start.elapsed().as_secs_f64() * 1000.0)
                    };
                    validate_page(&page, rows, offset, size);
                    samples[index].push(json!({"repeat":repeat+1,"elapsedMs":page.get("elapsedMs"),"wallMs":wall_ms}));
                    if repeat == 0 {
                        let id = format!("{dialect}-{rows}-{size}-{}", labels[index]);
                        write_public(dir, &format!("{id}.page.json"), &json!({
                            "schemaVersion":1,"caseId":id,"dialect":dialect,"rows":rows,"offset":offset,
                            "size":size,"repeats":REPEATS,"method":method,"sourceSha":sha,
                            "query":query,"page":page
                        }));
                    }
                }
                call(&mut *driver, "closeCursor", vec![cursor]);
            }
            for index in 0..3 {
                let id = format!("{dialect}-{rows}-{size}-{}", labels[index]);
                cases.push(json!({"caseId":id,"rows":rows,"offset":offsets[index],"size":size,
                    "method":if index == 0 {"runQuery"} else {"fetchResultPage"},"repeats":REPEATS,
                    "pageSample":format!("{id}.page.json"),"samples":samples[index],
                    "checks":{"returned":size,"firstId":offsets[index]+1,"lastId":offsets[index]+size,
                        "allIdsContinuous":true,"exactValues":true,"hasMore":offsets[index]+size<rows,"independentTotal":total}}));
            }
        }
        assert_eq!(observer.total(&table), total, "pagination must not mutate fixture rows");
        required(driver.disconnect(), "native disconnect");
        // Tables intentionally remain in their dedicated stopped fixture container.
    }
    write_public(dir, &format!("{dialect}.native.json"), &json!({
        "schemaVersion":1,"dialect":dialect,"sourceSha":sha,"environment":environment,
        "timingBoundary":{"wallMs":"actual native Driver::call, including database I/O and native conversion; excludes setup, validation, file writes and IPC",
            "elapsedMs":"native response elapsedMs, not database server-only time; null when fetchResultPage does not expose it",
            "endToEnd":false},"totals":totals,"cases":cases
    }));
}

#[test]
#[ignore = "requires dedicated PG17 fixture, ownership marker and public output directory"]
fn postgresql_pagination_performance_live() { run("postgresql"); }

#[test]
#[ignore = "requires dedicated MySQL8 fixture, ownership marker and public output directory"]
fn mysql_pagination_performance_live() { run("mysql"); }
