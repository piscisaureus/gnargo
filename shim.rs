use std::env::{args, current_dir, current_exe, var, vars};
use std::io::{stdin, *};
use std::net::{Shutdown, TcpStream};
use std::process::exit;

fn main() -> std::io::Result<()> {
    let port = var("SHIM_PORT").unwrap();
    let mut conn = TcpStream::connect(format!("127.0.0.1:{}", port))?;

    conn.write(format!("cwd {}\n", current_dir()?.to_str().unwrap()).as_bytes())?;
    conn.write(format!("exe {}\n", current_exe()?.to_str().unwrap()).as_bytes())?;
    for arg in args() {
        conn.write(format!("arg {}\n", arg).as_bytes())?;
    }
    for (var, value) in vars() {
        let value: String = value
            .chars()
            .map(|c| match c {
                '\n' | '\r' => ' ',
                _ => c,
            }).collect();
        conn.write(format!("env {}={}\n", var, value).as_bytes())?;
    }
    if env!("SHIM_READ_STDIN") == "1" {
        let stdin = stdin();
        for line in stdin.lock().lines() {
            conn.write(format!("in {}\n", line?).as_bytes())?;
        }
    }
    conn.write("end\n".as_bytes())?;

    let bufrd = BufReader::new(&conn);
    for line in bufrd.lines() {
        let line = line?;
        let mut it = line.splitn(2, " ");
        let cmd = it.next().unwrap();
        let payload = it.next().unwrap();

        match cmd {
            "out" => println!("{}", payload),
            "err" => println!("{}", payload),
            "ret" => {
                conn.shutdown(Shutdown::Both)?;
                exit(payload.parse().unwrap());
            }
            &_ => break,
        }
    }

    panic!("protocol error");
}
