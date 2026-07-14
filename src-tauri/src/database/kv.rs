//! Generischer Key-Value-Zugriff (verschachtelte JSON-Pfade).

use super::*;
use super::helpers::*;

impl Database {
    pub fn get(&self, key: &str, default_value: Value) -> Result<Value> {
        let segments = split_key(key)?;
        if segments[0] == "messages" {
            return Ok(default_value);
        }
        let connection = self.connection.lock();
        let Some(mut value) = self.load_top(&connection, segments[0])? else {
            return Ok(default_value);
        };

        for segment in &segments[1..] {
            let Some(next) = value.as_object().and_then(|object| object.get(*segment)) else {
                return Ok(default_value);
            };
            value = next.clone();
        }
        Ok(value)
    }

    pub fn set(&self, key: &str, value: Value) -> Result<bool> {
        let segments = split_key(key)?;
        if segments[0] == "messages" {
            return Err(AppError::InvalidInput(
                "messages must be changed through the paginated message API".into(),
            ));
        }

        let connection = self.connection.lock();
        let top_value = if segments.len() == 1 {
            value
        } else {
            let mut root = self
                .load_top(&connection, segments[0])?
                .filter(Value::is_object)
                .unwrap_or_else(|| Value::Object(Map::new()));
            set_nested(&mut root, &segments[1..], value);
            root
        };
        self.write_top(&connection, segments[0], &top_value)?;
        Ok(true)
    }

    pub fn delete(&self, key: &str) -> Result<bool> {
        let segments = split_key(key)?;
        if segments[0] == "messages" {
            return Err(AppError::InvalidInput(
                "messages must be changed through the message API".into(),
            ));
        }

        let connection = self.connection.lock();
        if segments.len() == 1 {
            return Ok(connection.execute("DELETE FROM kv WHERE key = ?1", [segments[0]])? > 0);
        }

        let Some(mut root) = self.load_top(&connection, segments[0])? else {
            return Ok(false);
        };
        if !delete_nested(&mut root, &segments[1..]) {
            return Ok(false);
        }
        self.write_top(&connection, segments[0], &root)?;
        Ok(true)
    }

}
