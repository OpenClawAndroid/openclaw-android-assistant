package ai.openclaw.app.chat

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteDriver
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.AndroidSQLiteDriver
import java.util.concurrent.atomic.AtomicInteger

internal class OutboxReadCountingDriver(
  private val delegate: SQLiteDriver = AndroidSQLiteDriver(),
) : SQLiteDriver by delegate {
  private val reads = AtomicInteger()
  private val outboxTable = Regex("\\b(?:FROM|JOIN)\\s+[`\"]?outbox_", RegexOption.IGNORE_CASE)

  fun resetReads() {
    reads.set(0)
  }

  fun readCount(): Int = reads.get()

  override fun open(fileName: String): SQLiteConnection {
    val connection = delegate.open(fileName)
    return object : SQLiteConnection by connection {
      override fun prepare(sql: String): SQLiteStatement {
        val statement = connection.prepare(sql)
        if (!sql.trimStart().startsWith("SELECT", ignoreCase = true) || !outboxTable.containsMatchIn(sql)) {
          return statement
        }
        return object : SQLiteStatement by statement {
          private var started = false

          override fun step(): Boolean {
            // Count executions, not preparation or each row returned by a cursor.
            if (!started) {
              started = true
              reads.incrementAndGet()
            }
            return statement.step()
          }

          override fun reset() {
            statement.reset()
            started = false
          }
        }
      }
    }
  }
}
